import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindOrder, mockFindAttempt, mockBuildConnector, mockTimeline } = vi.hoisted(() => ({
  mockFindOrder: vi.fn(),
  mockFindAttempt: vi.fn(),
  mockBuildConnector: vi.fn(),
  mockTimeline: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: mockFindOrder },
    providerAttempt: { findFirst: mockFindAttempt },
  },
}))
vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: mockBuildConnector,
}))
vi.mock('./order-state-machine', () => ({
  createTimelineEvent: mockTimeline,
}))

import { reconcileAmbiguousPurchase } from './ambiguous-purchase-reconciliation'

describe('reconcileAmbiguousPurchase (provider-neutral service)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOrder.mockResolvedValue({ id: 'o1', status: 'PROVIDER_RECONCILIATION', quantity: 1 })
    mockFindAttempt.mockResolvedValue({
      id: 'att-1', providerId: 'prov-choice', status: 'AMBIGUOUS',
      startedAt: new Date('2026-01-01T00:00:00Z'), metadata: { externalPlanId: 'SKU-1' },
    })
    mockTimeline.mockResolvedValue({})
  })

  it('delegates to the connector and returns a unique match', async () => {
    mockBuildConnector.mockResolvedValue({
      reconcileAmbiguousPurchase: vi.fn().mockResolvedValue({ success: true, data: { resolved: true, iccid: 'icc-1', reason: 'unique-match' } }),
    })
    const r = await reconcileAmbiguousPurchase('o1')
    expect(r.success).toBe(true)
    expect(r.resolved).toBe(true)
    expect(r.iccid).toBe('icc-1')
    expect(mockBuildConnector).toHaveBeenCalledWith('prov-choice')
  })

  it('keeps pending when the connector reports no-match', async () => {
    mockBuildConnector.mockResolvedValue({
      reconcileAmbiguousPurchase: vi.fn().mockResolvedValue({ success: true, data: { resolved: false, reason: 'no-match' } }),
    })
    const r = await reconcileAmbiguousPurchase('o1')
    expect(r.success).toBe(true)
    expect(r.resolved).toBe(false)
    expect(r.reason).toBe('no-match')
  })

  it('fails when the order is not in PROVIDER_RECONCILIATION', async () => {
    mockFindOrder.mockResolvedValue({ id: 'o1', status: 'FAILED', quantity: 1 })
    const r = await reconcileAmbiguousPurchase('o1')
    expect(r.success).toBe(false)
    expect(mockBuildConnector).not.toHaveBeenCalled()
  })

  it('fails when the provider has no reconcileAmbiguousPurchase method', async () => {
    mockBuildConnector.mockResolvedValue({})
    const r = await reconcileAmbiguousPurchase('o1')
    expect(r.success).toBe(false)
    expect(r.error).toContain('does not support')
  })
})
