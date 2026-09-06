import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    providerAttempt: { count: vi.fn().mockResolvedValue(0), create: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
    providerPackage: { findUnique: vi.fn() },
    eSIM: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({ getAdapterForType: vi.fn() }))
vi.mock('@/lib/services/jobs/provider-finalizer', () => ({
  completeProviderOperation: vi.fn(),
  failProviderOperation: vi.fn(),
}))
vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
  createTimelineEventForProvider: vi.fn(),
  transitionOrder: vi.fn(),
  failOrder: vi.fn(),
}))
vi.mock('@/lib/services/jobs/provider-job-engine', () => ({
  ProviderJobEngine: { createJob: vi.fn() },
}))
vi.mock('@/lib/services/orders/provider-attempt-number', () => ({
  allocateProviderAttemptNumber: vi.fn().mockResolvedValue(1),
}))
vi.mock('@/lib/esim/installation-data', () => ({
  normalizeConnectorInstallData: vi.fn(() => ({})),
}))

import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { completeProviderOperation } from '@/lib/services/jobs/provider-finalizer'
import { ProviderJobEngine } from '@/lib/services/jobs/provider-job-engine'
import { allocateProviderAttemptNumber } from './provider-attempt-number'
import { executeProviderAttempt } from './provider-attempt-service'

const mockPrisma = vi.mocked(prisma) as any
const mockGetAdapter = vi.mocked(getAdapterForType)
const mockActivate = vi.fn()
const mockComplete = vi.mocked(completeProviderOperation)
const mockCreateJob = vi.mocked(ProviderJobEngine.createJob)
const mockAttemptUpdate = mockPrisma.providerAttempt.update
const mockAllocateNumber = vi.mocked(allocateProviderAttemptNumber)

function attemptInput(providerId = 'prov-choice', providerName = 'Choice') {
  return {
    orderId: 'order-1',
    businessId: 'biz-1',
    providerId,
    providerName,
    planId: 'plan-1',
    quantity: 1,
    subscriber: { email: 'c@test.com' },
    totalAmount: 5,
    displayName: 'Test Plan',
    packageId: 'pkg-1',
    packageSnapshot: {},
    pkg: { id: 'pkg-1', dataGB: 1, validityDays: 7, currency: 'USD' },
    policy: 'STRICT' as const,
  }
}

const ORDER_ROW = {
  id: 'order-1',
  status: 'PENDING_PROVIDER',
  esims: [],
  userId: 'user-1',
  packageSnapshot: {},
  packageName: '',
  packageDataGB: null,
  packageValidityDays: null,
}

// NOTE: provider-failover-engine is intentionally NOT mocked — the REAL
// classifyProviderOutcome runs against each connector's actual error contract.
describe('executeProviderAttempt: ambiguous provider outcomes (real classifier)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(ORDER_ROW)
    mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'attempt-1' })
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-choice', type: 'url-token', apiBaseUrl: 'https://x', apiToken: 'tkn', environment: 'sandbox', authUrl: null, status: 'ACTIVE' })
    mockGetAdapter.mockResolvedValue({ activateESIM: mockActivate })
    mockAllocateNumber.mockResolvedValue(1)
  })

  describe('Choice', () => {
    it('add-bundle timeout (url-token-connector.ts:79 shape) → AMBIGUOUS, single dispatch, no finalize, no background job', async () => {
      mockActivate.mockResolvedValue({
        success: false,
        error: { code: 'TIMEOUT', message: 'Request timed out', details: { ambiguous: true, causeCode: 'ABORT' } },
      })

      const result = await executeProviderAttempt(attemptInput())

      expect(result).toMatchObject({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME' })
      expect(mockAttemptUpdate).toHaveBeenCalledWith({ where: { id: 'attempt-1' }, data: expect.objectContaining({ status: 'AMBIGUOUS', retryClassification: 'NON_RETRYABLE', errorCode: 'TIMEOUT' }) })
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })

    it('accepted purchase without ICCID (url-token-connector.ts:861-868 shape) → AMBIGUOUS and persists providerReference for reconciliation', async () => {
      mockActivate.mockResolvedValue({
        success: false,
        error: {
          code: 'NO_ICCIDS',
          message: 'Provider accepted the purchase but returned no ICCID — outcome is ambiguous and requires reconciliation',
          details: { retryable: false, ambiguous: true, upstreamConfirmed: true, providerOrderId: 'txn-choice-8891' },
        },
      })

      const result = await executeProviderAttempt(attemptInput())

      expect(result).toMatchObject({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME' })
      const updateCall = mockAttemptUpdate.mock.calls[0]?.[0] as { data?: any }
      expect(updateCall).toMatchObject({
        where: { id: 'attempt-1' },
        data: {
          status: 'AMBIGUOUS',
          retryClassification: 'NON_RETRYABLE',
          providerReference: 'txn-choice-8891',
          metadata: { ambiguous: true, upstreamConfirmed: true, providerOrderId: 'txn-choice-8891' },
        },
      })
      // reconcileAmbiguousPurchase (reconciliation.ts:239) reads the persisted
      // providerReference to re-query Choice — the Choice reconciliation path
      // stays usable because this reference survives.
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })
  })

  describe('iBASIS', () => {
    it('buy request timed out (ibasis-connector.ts:312-314 + :166 normalized shape) → AMBIGUOUS, NOT FAILED', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-ibasis', type: 'ibasis', apiBaseUrl: 'https://x', apiToken: 'tkn', environment: 'sandbox', authUrl: null, status: 'ACTIVE' })
      mockActivate.mockResolvedValue({ success: false, error: { code: 'NETWORK_ERROR', message: 'iBASIS request timed out after 15000ms' } })

      const result = await executeProviderAttempt(attemptInput('prov-ibasis', 'iBASIS'))

      expect(result.status).toBe('AMBIGUOUS')
      expect(result.status).not.toBe('FAILED')
      expect(mockAttemptUpdate).toHaveBeenCalledWith({ where: { id: 'attempt-1' }, data: expect.objectContaining({ status: 'AMBIGUOUS', retryClassification: 'NON_RETRYABLE', errorCode: 'NETWORK_ERROR' }) })
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })

    it('generic transport failure (ibasis-connector.ts:320 shape) → AMBIGUOUS', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-ibasis', type: 'ibasis', apiBaseUrl: 'https://x', apiToken: 'tkn', environment: 'sandbox', authUrl: null, status: 'ACTIVE' })
      mockActivate.mockResolvedValue({ success: false, error: { code: 'NETWORK_ERROR', message: 'iBASIS request failed: fetch failed' } })

      const result = await executeProviderAttempt(attemptInput('prov-ibasis', 'iBASIS'))

      expect(result).toMatchObject({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME' })
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })
  })

  describe('USMatrix', () => {
    it('assign-package request timed out (usmatrix-connector.ts:214-215 shape) → AMBIGUOUS', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-usmatrix', type: 'usmatrix', apiBaseUrl: 'https://x', apiToken: 'tkn', environment: 'sandbox', authUrl: null, status: 'ACTIVE' })
      mockActivate.mockResolvedValue({ success: false, error: { code: 'TIMEOUT', message: 'Request timed out' } })

      const result = await executeProviderAttempt(attemptInput('prov-usmatrix', 'USMatrix'))

      expect(result).toMatchObject({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME' })
      expect(mockAttemptUpdate).toHaveBeenCalledWith({ where: { id: 'attempt-1' }, data: expect.objectContaining({ status: 'AMBIGUOUS', retryClassification: 'NON_RETRYABLE', errorCode: 'TIMEOUT' }) })
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })

    it('assign-package network failure (usmatrix-connector.ts:214-215 shape) → AMBIGUOUS', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-usmatrix', type: 'usmatrix', apiBaseUrl: 'https://x', apiToken: 'tkn', environment: 'sandbox', authUrl: null, status: 'ACTIVE' })
      mockActivate.mockResolvedValue({ success: false, error: { code: 'NETWORK_ERROR', message: 'US-Matrix request failed: fetch failed' } })

      const result = await executeProviderAttempt(attemptInput('prov-usmatrix', 'USMatrix'))

      expect(result).toMatchObject({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME' })
      expect(mockActivate).toHaveBeenCalledTimes(1)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockCreateJob).not.toHaveBeenCalled()
    })
  })
})