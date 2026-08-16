import { prisma } from '@/lib/prisma'
import { ProviderRoutingEngine } from './provider-routing-engine'
import type { ProviderScore } from './provider-routing-engine'

export type RetryClassification = 'RETRYABLE' | 'NON_RETRYABLE'

export interface FailoverAttempt {
  attempt: number
  providerId: string
  providerName: string
  startedAt: Date
  endedAt?: Date
  result: 'success' | 'failure' | 'pending'
  retryClassification?: RetryClassification
  errorCode?: string
  errorMessage?: string
  providerReference?: string
  latencyMs?: number
}

export function classifyRetry(error: { code?: string; message?: string; details?: any } | undefined | null): RetryClassification {
  if (!error) return 'NON_RETRYABLE'
  if (error.details?.retryable === true) return 'RETRYABLE'
  const code = (error.code || '').toUpperCase()
  const msg = (error.message || '').toLowerCase()
  const retryableCodes = ['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'MAINTENANCE', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'OUT_OF_STOCK']
  const retryablePatterns = ['timeout', 'timed out', 'network', 'connection refused', 'dns', 'unavailable', 'rate limit', 'maintenance', 'gateway timeout', '502', '503', '504', 'temporary']
  if (retryableCodes.includes(code)) return 'RETRYABLE'
  if (retryablePatterns.some(p => msg.includes(p))) return 'RETRYABLE'
  const nonRetryableCodes = ['AUTH_FAILED', 'INVALID_CREDENTIALS', 'INVALID_PACKAGE', 'INVALID_ICCID', 'NO_ICCIDS', 'INSUFFICIENT_BALANCE', 'PROVIDER_FAILED', 'VALIDATION_FAILED', 'INVALID_INPUT', 'DUPLICATE', 'NOT_SUPPORTED', 'PROVIDER_NO_PURCHASE']
  if (nonRetryableCodes.includes(code)) return 'NON_RETRYABLE'
  return 'NON_RETRYABLE'
}

export class ProviderFailoverEngine {
  private maxAttempts: number
  private attempted: Set<string>

  constructor(maxAttempts = 3) {
    this.maxAttempts = maxAttempts
    this.attempted = new Set()
  }

  markAttempted(providerId: string) {
    this.attempted.add(providerId)
  }

  isAttempted(providerId: string): boolean {
    return this.attempted.has(providerId)
  }

  shouldFailover(error: { code?: string; message?: string; details?: any } | undefined, attemptHistory: FailoverAttempt[]): boolean {
    if (attemptHistory.length >= this.maxAttempts) return false
    const classification = classifyRetry(error)
    if (classification !== 'RETRYABLE') return false
    return true
  }

  async getNextProvider(rankedProviders: ProviderScore[], attemptedIds: string[], excludeIds: string[] = []): Promise<ProviderScore | null> {
    const allExcluded = new Set([...attemptedIds, ...excludeIds])
    const candidate = rankedProviders.find(p => !allExcluded.has(p.providerId))
    return candidate || null
  }

  async getRankedProviders(packageId?: string, quantity?: number, excludeIds?: string[]): Promise<ProviderScore[]> {
    const engine = new ProviderRoutingEngine()
    const result = await engine.selectBestProvider({ packageId, quantity, excludeProviderIds: excludeIds })
    return result.candidates || (result.selected ? [result.selected] : [])
  }

  async verifyOrderNotCompleted(orderId: string): Promise<boolean> {
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: orderId },
      include: { esims: true },
    })
    if (!order) return false
    if (order.status === 'FULFILLED') return false
    if (order.esims.length > 0) return false
    return true
  }

  recordAttempt(history: FailoverAttempt[], attempt: FailoverAttempt): FailoverAttempt[] {
    return [...history, attempt]
  }
}

// ─────────────────────────────────────────────
// Circuit Breaker (Task 5)
// ─────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

const CIRCUIT_WINDOW_MS =
  parseInt(process.env.PROVIDER_CIRCUIT_WINDOW_MINUTES || '10', 10) * 60 * 1000
const CIRCUIT_OPEN_MS =
  parseInt(process.env.PROVIDER_CIRCUIT_OPEN_MINUTES || '15', 10) * 60 * 1000
const CIRCUIT_FAILURE_THRESHOLD =
  parseInt(process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD || '5', 10)

export async function getProviderCircuitState(providerId: string): Promise<CircuitState> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { config: true },
  })
  const cfg = (provider?.config as any) || {}
  const circuit = cfg.circuitBreaker || {}
  if (circuit.state === 'OPEN') {
    if (Date.now() - (circuit.openedAt || 0) > CIRCUIT_OPEN_MS) {
      await setCircuitState(providerId, 'HALF_OPEN')
      return 'HALF_OPEN'
    }
    return 'OPEN'
  }
  return (circuit.state || 'CLOSED') as CircuitState
}

export async function recordCircuitFailure(providerId: string) {
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
  const cfg = (provider?.config as any) || {}
  const circuit = cfg.circuitBreaker || {}
  const now = Date.now()
  const failures = (circuit.recentFailures || []).filter((f: any) => now - f.time < CIRCUIT_WINDOW_MS)
  failures.push({ time: now })
  if (failures.length >= CIRCUIT_FAILURE_THRESHOLD) {
    await setCircuitState(providerId, 'OPEN')
    await createTimelineEventForProvider(providerId, 'PROVIDER_CIRCUIT_OPENED', `Circuit opened after ${failures.length} failures`)
  } else {
    await setCircuitProviderConfig(providerId, { circuitBreaker: { state: circuit.state || 'CLOSED', recentFailures: failures } })
  }
}

export async function recordCircuitSuccess(providerId: string) {
  await setCircuitState(providerId, 'CLOSED')
  await createTimelineEventForProvider(providerId, 'PROVIDER_CIRCUIT_CLOSED', 'Circuit closed — success confirmed')
}

async function setCircuitState(providerId: string, state: CircuitState) {
  await setCircuitProviderConfig(providerId, {
    circuitBreaker: { state, openedAt: state === 'OPEN' ? Date.now() : undefined, recentFailures: state === 'CLOSED' ? [] : undefined },
  })
}

async function setCircuitProviderConfig(providerId: string, circuitData: any) {
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
  const cfg = (provider?.config as any) || {}
  cfg.circuitBreaker = { ...(cfg.circuitBreaker || {}), ...circuitData.circuitBreaker }
  await prisma.provider.update({ where: { id: providerId }, data: { config: cfg } }).catch(() => {})
}

async function createTimelineEventForProvider(providerId: string, eventType: string, message: string) {
  // Log to provider config for now — no dedicated provider timeline
}

// ─────────────────────────────────────────────
// Safe Failover Classification (Task 6)
// ─────────────────────────────────────────────

export type FailoverEligibility =
  | 'FAILOVER_ALLOWED'
  | 'RETRY_SAME_PROVIDER'
  | 'RECONCILIATION_REQUIRED'
  | 'NO_ALTERNATIVE'
  | 'NOT_ALLOWED'
  | 'ORDER_COMPLETE'

export interface FailoverCheckInput {
  providerReservationId?: string | null
  providerFulfillId?: string | null
  walletCaptured: boolean
  hasEsims: boolean
  providerError?: { code?: string; message?: string } | null
  isActiveReconciliation: boolean
  hasPendingProviderAttempt: boolean
}

/**
 * Determine whether the order can safely fail over to another provider.
 * FAILOVER_ALLOWED only when the current provider definitely did not succeed.
 */
export function classifyFailoverEligibility(input: FailoverCheckInput): FailoverEligibility {
  const { providerReservationId, providerFulfillId, walletCaptured, hasEsims, providerError, isActiveReconciliation, hasPendingProviderAttempt } = input

  if (walletCaptured || hasEsims || providerFulfillId) return 'ORDER_COMPLETE'
  if (providerReservationId) return 'RECONCILIATION_REQUIRED'
  if (isActiveReconciliation) return 'RECONCILIATION_REQUIRED'
  if (hasPendingProviderAttempt) return 'RECONCILIATION_REQUIRED'

  // Uncertain transport errors → reconcile, don't fail over
  const uncertainCodes = ['TIMEOUT', 'NETWORK_ERROR', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'ECONNRESET', 'ETIMEDOUT', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'MAINTENANCE']
  const uncertainPatterns = ['timeout', 'connection reset', 'socket hang up', '503', '502', '504', 'connection refused']

  if (providerError) {
    const code = (providerError.code || '').toUpperCase()
    const msg = (providerError.message || '').toLowerCase()
    if (uncertainCodes.includes(code) || uncertainPatterns.some(p => msg.includes(p))) {
      return 'RECONCILIATION_REQUIRED'
    }
  }

  // Definite safe failures → allow failover
  return 'FAILOVER_ALLOWED'
}
