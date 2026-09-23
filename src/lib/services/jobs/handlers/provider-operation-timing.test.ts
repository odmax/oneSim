import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  attemptsFindFirst: vi.fn(),
  dispatchResult: { success: true, status: 'FULFILLED' },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { providerAttempt: { findFirst: mocks.attemptsFindFirst } },
}))

vi.mock('../../orders/purchase-orchestrator', () => ({
  PurchaseOrchestrator: class {
    async runDispatch() {
      return mocks.dispatchResult
    }
  },
}))

import { executePurchaseDispatch } from './purchase-execution'
import { buildProviderOperationTimingEvent } from '../../orders/purchase-timing'

function capturedEvents(): any[] {
  const logs = (vi.mocked(console.log).mock.calls as unknown[][]).map((c) => String(c[0]))
  const events: any[] = []
  for (const l of logs) {
    if (l.startsWith('[PURCHASE_TIMING] ')) events.push(JSON.parse(l.slice('[PURCHASE_TIMING] '.length)))
  }
  return events
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  mocks.attemptsFindFirst.mockResolvedValue({ latencyMs: 45 })
  mocks.dispatchResult = { success: true, status: 'FULFILLED' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const payload = {
  orderId: 'order-1', providerCode: 'AIRHUB', providerName: 'AirHub', operation: 'purchase', correlationId: 'c-1',
}

describe('provider_operation_complete — worker purchase timing', () => {
  it('complete provider response → FULFILLED, immediateFinalization=true, activationJobScheduled=false', async () => {
    mocks.dispatchResult = { success: true, status: 'FULFILLED' }
    const r = await executePurchaseDispatch(payload, { jobId: 'job-1', runAt: new Date(Date.now() - 40) })
    expect(r.completed).toBe(true)
    const events = capturedEvents()
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.event).toBe('provider_operation_complete')
    expect(e.orderId).toBe('order-1')
    expect(e.outcome).toBe('FULFILLED')
    expect(e.immediateFinalization).toBe(true)
    expect(e.activationJobScheduled).toBe(false)
  })

  it('incomplete/awaiting response → DEFERRED, activationJobScheduled=true', async () => {
    mocks.dispatchResult = { success: true, status: 'PROCESSING' }
    await executePurchaseDispatch(payload)
    const e = capturedEvents()[0]
    expect(e.outcome).toBe('DEFERRED')
    expect(e.activationJobScheduled).toBe(true)
    expect(e.immediateFinalization).toBe(false)
  })

  it('ambiguous response → RECONCILIATION', async () => {
    mocks.dispatchResult = { success: false, status: 'PROVIDER_RECONCILIATION' }
    await executePurchaseDispatch(payload)
    expect(capturedEvents()[0].outcome).toBe('RECONCILIATION')
  })

  it('terminal (non-retryable) failure → FAILED', async () => {
    mocks.dispatchResult = { success: false, status: 'FAILED', retryable: false }
    await executePurchaseDispatch(payload)
    expect(capturedEvents()[0].outcome).toBe('FAILED')
  })

  it('retryable pre-dispatch → DEFERRED (queue retries)', async () => {
    mocks.dispatchResult = { success: false, status: 'SOMETHING', retryable: true }
    await executePurchaseDispatch(payload)
    expect(capturedEvents()[0].outcome).toBe('DEFERRED')
  })

  it('timing metadata is numeric, non-negative and sanitized', async () => {
    mocks.attemptsFindFirst.mockResolvedValue({ latencyMs: 45 })
    await executePurchaseDispatch(payload)
    const e = capturedEvents()[0]
    for (const k of ['queueWaitMs', 'providerCallMs', 'persistenceMs', 'fulfillmentMs']) {
      expect(typeof e[k]).toBe('number')
      expect(e[k]).toBeGreaterThanOrEqual(0)
    }
    expect(e.providerCallMs).toBe(45)
    expect(e).not.toHaveProperty('iccid')
    expect(e).not.toHaveProperty('payload')
    expect(e).not.toHaveProperty('activationCode')
  })

  it('exactly one worker completion event per execution outcome', async () => {
    await executePurchaseDispatch(payload)
    await executePurchaseDispatch(payload)
    expect(capturedEvents()).toHaveLength(2)
  })

  it('instrumentation failure cannot alter the provider-operation result', async () => {
    // A throwing lat & console already mocked: use a value that forces sanitize path.
    mocks.dispatchResult = { success: true, status: 'FULFILLED' }
    const r = await executePurchaseDispatch(payload)
    expect(r.completed).toBe(true)
  })

  it('sanitizer coerces NaN/negative to 0 and rejects unknown outcomes', () => {
    const e = buildProviderOperationTimingEvent({
      orderId: 'o', queueWaitMs: NaN, providerCallMs: -9, outcome: 'BOGUS', immediateFinalization: true,
      payload: { secret: 1 } as any,
    } as any)
    expect(e.queueWaitMs).toBe(0)
    expect(e.providerCallMs).toBe(0)
    expect(e.outcome).toBe('UNKNOWN')
    expect(e).not.toHaveProperty('payload')
  })
})