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
  const retryableCodes = ['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'MAINTENANCE', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE']
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
