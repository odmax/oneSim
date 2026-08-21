import { describe, it, expect } from 'vitest'
import { shouldStopPolling, nextPollDelayMs } from './order-polling'

describe('order status polling policy (Buy eSIM flow)', () => {
  it('keeps polling while the purchase is in flight', () => {
    for (const s of ['CREATED', 'PAYMENT_RESERVED', 'PENDING_PROVIDER', 'PROVIDER_ACCEPTED', 'RESERVED', 'FULFILLING']) {
      expect(shouldStopPolling(s)).toBe(false)
    }
  })

  it('stops polling once the outcome is final', () => {
    for (const s of ['FULFILLED', 'FAILED', 'CANCELLED', 'REFUNDED', 'EXPIRED', 'INSTALLED', 'ACTIVE', 'PARTIALLY_FULFILLED']) {
      expect(shouldStopPolling(s)).toBe(true)
    }
  })

  it('polls in-flight orders at the fast ~2.5s cadence', () => {
    expect(nextPollDelayMs('PENDING_PROVIDER')).toBe(2500)
    expect(nextPollDelayMs('PAYMENT_RESERVED')).toBe(2500)
  })

  it('keeps a slower watch on PROVIDER_RECONCILIATION instead of abandoning it', () => {
    expect(shouldStopPolling('PROVIDER_RECONCILIATION')).toBe(false)
    expect(nextPollDelayMs('PROVIDER_RECONCILIATION')).toBeGreaterThan(2500)
  })
})
