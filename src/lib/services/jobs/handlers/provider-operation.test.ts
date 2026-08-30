import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActivateESIMResult } from '@/lib/providers/connectors/connector-interface'

const order = { id: 'order-1', businessId: 'biz-1', userId: 'u1', status: 'PENDING_PROVIDER', totalAmount: { toString: () => '10' }, packageSnapshot: null, packageName: 'Test', packageDataGB: 1, packageValidityDays: 7, esims: [], providerId: 'prov-1' }

const mockDb = vi.hoisted(() => ({
  eSIMPurchase: { findUnique: vi.fn() },
  provider: { findUnique: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: mockDb,
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
}))

vi.mock('../provider-finalizer', () => ({
  completeProviderOperation: vi.fn().mockResolvedValue({ success: true }),
  failProviderOperation: vi.fn(),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  transitionOrder: vi.fn().mockResolvedValue({ success: true }),
  createTimelineEvent: vi.fn(),
  failOrder: vi.fn(),
}))

vi.mock('./purchase-execution', () => ({
  executePurchaseDispatch: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { completeProviderOperation, failProviderOperation } from '../provider-finalizer'
import { transitionOrder } from '@/lib/services/orders/order-state-machine'
import {
  executeProviderOperation,
  classifyActivationPollError,
  reconcileActivationOrder,
  reconcileExhaustedActivationJob,
} from './provider-operation'

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)
const mockComplete = vi.mocked(completeProviderOperation)
const mockFail = vi.mocked(failProviderOperation)
const mockTransition = vi.mocked(transitionOrder)

const BASE = {
  orderId: 'order-1',
  businessId: 'biz-1',
  providerId: 'prov-1',
  providerRef: 'ref-1',
  totalAmount: 10,
  operation: 'activation',
} as any

function setupAdapter(statusResult: any) {
  mockAdapter.mockResolvedValue({
    getActivationStatus: vi.fn().mockResolvedValue(statusResult),
  } as any)
}

function status(overrides: Partial<ActivateESIMResult> & any = {}) {
  return { success: true, data: { status: 'ACTIVE', iccids: ['89012345678901234567'], ...overrides } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ ...order })
  mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-1', name: 'P', type: 'CUSTOM', apiBaseUrl: '', apiToken: '', environment: 'staging', authUrl: '', apiBaseUrl2: undefined })
  mockComplete.mockResolvedValue({ success: true })
})

describe('classifyActivationPollError — provider-neutral', () => {
  it('classifies transport/timeout errors as STILL_PROCESSING (retry)', () => {
    for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'HTTP_503']) {
      expect(classifyActivationPollError({ code })).toBe('STILL_PROCESSING')
    }
  })

  it('classifies HTTP 4xx / auth / not-found as RECONCILIATION_REQUIRED (never fake PENDING)', () => {
    for (const code of ['AUTH_ERROR', 'HTTP_400', 'NOT_FOUND', 'NOT_SUPPORTED', 'VALIDATION_ERROR']) {
      expect(classifyActivationPollError({ code })).toBe('RECONCILIATION_REQUIRED')
    }
  })

  it('classifies any ambiguous outcome as RECONCILIATION_REQUIRED', () => {
    expect(classifyActivationPollError({ code: 'NO_ICCIDS', details: { ambiguous: true } })).toBe('RECONCILIATION_REQUIRED')
  })

  it('miss→ng error → RECONCILIATION_REQUIRED (cannot confirm)', () => {
    expect(classifyActivationPollError(undefined)).toBe('RECONCILIATION_REQUIRED')
  })
})

describe('executeProviderOperation — activation polling', () => {
  it('forwards ACTIVE + ICCID to completeProviderOperation and completes', async () => {
    setupAdapter(status())
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1', providerRef: 'ref-1', iccids: ['89012345678901234567'],
    }))
    expect(mockFail).not.toHaveBeenCalled()
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('forwards install/activation data recovered from status lookup', async () => {
    setupAdapter(status({ activationCode: 'LPA:1$smdp$x', qrCodeUrl: 'https://x', smdpAddress: 'smdp', matchingId: 'm' }))
    await executeProviderOperation({ ...BASE, providerRef: '12811381' })
    expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
      providerRef: '12811381',
      activationCode: 'LPA:1$smdp$x',
      qrCodeUrl: 'https://x',
      smdpAddress: 'smdp',
      matchingId: 'm',
    }))
  })

  it('ACTIVE without any fulfillment evidence → reconciliation, never completes', async () => {
    setupAdapter({ success: true, data: { status: 'ACTIVE' } })
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(result.error).toMatch(/ACTIVE.*evidence/i)
    expect(mockComplete).not.toHaveBeenCalled()
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
  })

  it('explicit FAILED status → failProviderOperation (terminal), not pending', async () => {
    setupAdapter({ success: true, data: { status: 'FAILED' } })
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(mockFail).toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('genuine PENDING/PROCESSING → retried with real status, wallet untouched', async () => {
    setupAdapter({ success: true, data: { status: 'PROCESSING', iccids: [] } })
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('Still processing: PROCESSING')
    expect(mockComplete).not.toHaveBeenCalled()
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('lookup TIMEOUT is preserved and retried — it is NEVER converted into fake PENDING', async () => {
    setupAdapter({ success: false, error: { code: 'TIMEOUT', message: 'AirHub status check timed out' } })
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('TIMEOUT')
    expect(result.error).not.toContain('Still processing: PENDING')
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('lookup NOT_FOUND → reconciliation (wallet/order preserved, real error kept)', async () => {
    setupAdapter({ success: false, error: { code: 'NOT_FOUND', message: 'order not found' } })
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(result.error).toContain('NOT_FOUND')
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
    expect(mockFail).not.toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('a thrown lookup error is preserved and retried (transient)', async () => {
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockRejectedValue(new Error('fetch failed')),
    } as any)
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('fetch failed')
  })

  it('missing provider row → reconciliation, not endless pending', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
  })

  it('no status lookup support → reconciliation (cannot confirm)', async () => {
    mockAdapter.mockResolvedValue({} as any)
    const result = await executeProviderOperation(BASE)
    expect(result.completed).toBe(true)
    expect(result.error).toContain('reconciliation')
  })

  it('duplicate poll on an already-FULFILLED order completes without re-finalizing', async () => {
    setupAdapter(status())
    let mutable = { ...order, status: 'FULFILLED' }
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ ...mutable })
    const result = await executeProviderOperation({ ...BASE, providerRef: 'x1' })
    expect(result.completed).toBe(true)
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('delegates purchase-dispatch jobs untouched', async () => {
    const { executePurchaseDispatch } = await import('./purchase-execution')
    ;(executePurchaseDispatch as any).mockResolvedValue({ completed: false, error: 'retry' })
    const result = await executeProviderOperation({ orderId: 'o', operation: 'purchase' })
    expect(result.completed).toBe(false)
    expect(result.error).toBe('retry')
    expect(mockTransition).not.toHaveBeenCalled()
  })
})

describe('reconciliation helpers', () => {
  it('reconcileActivationOrder only touches non-terminal pre-fulfillment orders', async () => {
    const states = ['FULFILLED', 'CANCELLED', 'REFUNDED', 'FAILED', 'PROVIDER_RECONCILIATION']
    for (const state of states) {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: state })
      const applied = await reconcileActivationOrder('order-1', 'x')
      expect(applied).toBe(false)
      expect(mockTransition).not.toHaveBeenCalled()
    }
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING_PROVIDER' })
    const applied = await reconcileActivationOrder('order-1', 'x')
    expect(applied).toBe(true)
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
  })

  it('reconcileExhaustedActivationJob only fires for activation jobs with an order id', async () => {
    await reconcileExhaustedActivationJob({ operation: 'activation', orderId: 'order-1' })
    expect(mockTransition).toHaveBeenCalled()
    mockTransition.mockClear()
    await reconcileExhaustedActivationJob({ operation: 'purchase', orderId: 'order-1' })
    await reconcileExhaustedActivationJob({})
    expect(mockTransition).not.toHaveBeenCalled()
  })
})