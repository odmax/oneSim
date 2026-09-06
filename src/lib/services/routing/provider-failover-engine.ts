import { prisma } from '@/lib/prisma'
import { ProviderRoutingEngine } from './provider-routing-engine'
import type { ProviderScore } from './provider-routing-engine'

export type RetryClassification = 'RETRYABLE' | 'NON_RETRYABLE'

/**
 * Outcome of a provider operation, used by the purchase orchestrator to decide
 * whether a failure is safe to retry/fail-over or is AMBIGUOUS (the provider may
 * have already completed a billable mutation, e.g. a POST that timed out).
 */
export type ProviderOutcome =
  | 'DEFINITIVE_FAILURE'
  | 'RETRYABLE_PRE_DISPATCH'
  | 'AMBIGUOUS_PROVIDER_OUTCOME'

/**
 * Classify a provider error into a safe outcome. The key distinction:
 *  - AMBIGUOUS_PROVIDER_OUTCOME: the request may have reached the provider
 *    (TIMEOUT / connection reset / socket hang-up). Never retry/fail-over.
 *  - RETRYABLE_PRE_DISPATCH: the connection was never established (refused/DNS).
 *  - DEFINITIVE_FAILURE: the provider explicitly rejected the operation.
 */
export function classifyProviderOutcome(error: { code?: string; message?: string; details?: any } | undefined | null): ProviderOutcome {
  if (!error) return 'DEFINITIVE_FAILURE'
  if (error.details?.ambiguous === true) return 'AMBIGUOUS_PROVIDER_OUTCOME'
  if (error.details?.preDispatch === true) return 'RETRYABLE_PRE_DISPATCH'

  const code = (error.code || '').toUpperCase()
  const msg = (error.message || '').toLowerCase()
  const causeCode = String(error.details?.causeCode || '').toUpperCase()

  const ambiguousCodes = ['TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ECONNABORTED']
  if (ambiguousCodes.includes(code) || ambiguousCodes.includes(causeCode)) return 'AMBIGUOUS_PROVIDER_OUTCOME'
  if (code.includes('TIMEOUT')) return 'AMBIGUOUS_PROVIDER_OUTCOME'
  if (/(timeout|timed out|socket hang up|connection reset|econnreset|etimedout|read econnreset|socket closed|econnaborted)/.test(msg)) return 'AMBIGUOUS_PROVIDER_OUTCOME'

  const preDispatchCodes = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'DNS', 'UND_ERR_CONNECT_TIMEOUT']
  if (preDispatchCodes.includes(code) || preDispatchCodes.includes(causeCode)) return 'RETRYABLE_PRE_DISPATCH'
  if (/(connection refused|econnrefused|dns|enotfound|getaddrinfo|eai_again)/.test(msg)) return 'RETRYABLE_PRE_DISPATCH'

  // Post-dispatch transport / unknown-response outcomes are AMBIGUOUS — the
  // billable mutation may have reached the provider. This is the INVERTED
  // default: never retry/fail-over/release unless the failure is provably
  // pre-dispatch (details.preDispatch/ECONNREFUSED/DNS) or the provider
  // explicitly rejected the request.
  const transportCodes = [
    'NETWORK_ERROR', 'PROVIDER_ERROR', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT',
    'CONNECTION_ERROR', 'FETCH_ERROR', 'REQUEST_FAILED', 'NON_JSON_RESPONSE',
    'INVALID_JSON', 'EMPTY_RESPONSE', 'GATEWAY_TIMEOUT', 'BAD_GATEWAY',
    'SERVICE_UNAVAILABLE', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
  ]
  if (transportCodes.includes(code) || transportCodes.includes(causeCode)) return 'AMBIGUOUS_PROVIDER_OUTCOME'
  if (/^(HTTP_)?5\d\d$/.test(code)) return 'AMBIGUOUS_PROVIDER_OUTCOME'
  if (/(bad gateway|gateway timeout|internal server error|service unavailable)/.test(msg)) return 'AMBIGUOUS_PROVIDER_OUTCOME'

  // Explicit rate-limit / throttling — provably received and refused before
  // commit. Safe to retry/fail-over (never ambiguous), so rate-limited providers
  // stay in the failover path instead of routing to reconciliation.
  const rateLimitCodes = ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'THROTTLED', 'TOO_MANY_REQUESTS']
  if (rateLimitCodes.includes(code) || rateLimitCodes.includes(causeCode)) return 'RETRYABLE_PRE_DISPATCH'
  if (/(rate limit|rate limited|too many requests|throttled)/.test(msg)) return 'RETRYABLE_PRE_DISPATCH'

  // Explicit provider rejection — provably received and refused before commit.
  const definitiveCodes = [
    'AUTH_ERROR', 'AUTH_FAILED', 'INVALID_CREDENTIALS', 'UNAUTHORIZED', 'FORBIDDEN',
    'INVALID_REQUEST', 'VALIDATION_FAILED', 'INVALID_INPUT', 'INVALID_PACKAGE',
    'INVALID_ICCID', 'INVALID_PLAN', 'PROVIDER_CONFIG', 'CONFIG_INVALID',
    'PROVIDER_FAILED', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS', 'OUT_OF_STOCK',
    'NO_ICCIDS', 'DUPLICATE', 'DUPLICATE_ORDER', 'ALREADY_EXISTS',
    'NOT_SUPPORTED', 'UNSUPPORTED', 'NOT_FOUND',
  ]
  if (definitiveCodes.includes(code)) return 'DEFINITIVE_FAILURE'
  if (/^(HTTP_)?4\d\d$/.test(code)) return 'DEFINITIVE_FAILURE'

  // Inverted default: any unrecognized error after a mutating dispatch is
  // treated as potentially-committed → AMBIGUOUS, never a blind release/retry.
  return 'AMBIGUOUS_PROVIDER_OUTCOME'
}

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

  // Uncertain transport errors → reconcile, don't fail over. Post-dispatch
  // transport/unknown outcomes are NEVER fail-over candidates (inverted default).
  const uncertainCodes = [
    'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE',
    'ECONNRESET', 'ETIMEDOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'RATE_LIMITED',
    'MAINTENANCE', 'NON_JSON_RESPONSE', 'INVALID_JSON', 'EMPTY_RESPONSE',
    'CONNECTION_ERROR', 'FETCH_ERROR', 'REQUEST_FAILED', 'BAD_GATEWAY',
    'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
  ]
  const uncertainPatterns = ['timeout', 'connection reset', 'socket hang up', '503', '502', '504', 'connection refused', 'network error', 'bad gateway', 'internal server error', 'service unavailable']

  if (providerError) {
    const code = (providerError.code || '').toUpperCase()
    const msg = (providerError.message || '').toLowerCase()
    if (uncertainCodes.includes(code) || /^(HTTP_)?5\d\d$/.test(code) || uncertainPatterns.some(p => msg.includes(p))) {
      return 'RECONCILIATION_REQUIRED'
    }
    // Explicit provider rejection — provably refused before any commit → failover
    // is safe. Anything unrecognized is treated conservatively (reconcile).
    const definitiveCodes = [
      'AUTH_ERROR', 'AUTH_FAILED', 'INVALID_CREDENTIALS', 'UNAUTHORIZED', 'FORBIDDEN',
      'INVALID_REQUEST', 'VALIDATION_FAILED', 'INVALID_INPUT', 'INVALID_PACKAGE',
      'INVALID_ICCID', 'INVALID_PLAN', 'PROVIDER_CONFIG', 'CONFIG_INVALID',
      'PROVIDER_FAILED', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS', 'OUT_OF_STOCK',
      'DUPLICATE', 'DUPLICATE_ORDER', 'ALREADY_EXISTS', 'NOT_SUPPORTED', 'UNSUPPORTED',
      'NOT_FOUND', 'PACKAGE_UNAVAILABLE', 'PROVIDER_PACKAGE_MISMATCH',
    ]
    if (definitiveCodes.includes(code) || /^(HTTP_)?4\d\d$/.test(code)) {
      return 'FAILOVER_ALLOWED'
    }
    return 'RECONCILIATION_REQUIRED'
  }

  // Definite safe failures → allow failover
  return 'FAILOVER_ALLOWED'
}
