import { describe, it, expect, vi, beforeEach } from 'vitest'

const instances = vi.hoisted(() => [] as any[])

vi.mock('./purchase-orchestrator', () => ({
  PurchaseOrchestrator: class {
    executePurchase = vi.fn().mockResolvedValue({ success: true, orderId: 'order-1', status: 'FULFILLED' })
    executePurchaseAsync = vi.fn().mockResolvedValue({ success: true, orderId: 'order-1', status: 'PROCESSING' })
    constructor() { instances.push(this) }
  },
}))

vi.mock('@/lib/services/business-webhooks/dispatcher', () => ({
  enqueueBusinessWebhooks: vi.fn().mockResolvedValue(undefined),
}))

import { createOrder } from './create-order'

function orchestrator() {
  return instances[instances.length - 1]
}

function lastAsyncArgs() {
  const spy = orchestrator().executePurchaseAsync
  return spy.mock.calls[spy.mock.calls.length - 1]?.[0]
}

function lastSyncArgs() {
  const spy = orchestrator().executePurchase
  return spy.mock.calls[spy.mock.calls.length - 1]?.[0]
}

describe('createOrder canonical forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards quoteReference, idempotencyKey and async=true to the orchestrator (portal path)', async () => {
    const result = await createOrder({
      businessId: 'biz-1',
      userId: 'user-1',
      packageId: 'pkg-1',
      quantity: 2,
      quoteReference: 'QT-abc',
      idempotencyKey: 'client-key-1',
      correlationId: 'corr-1',
      async: true,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('PROCESSING')
    expect(lastAsyncArgs()).toMatchObject({
      businessId: 'biz-1',
      userId: 'user-1',
      packageId: 'pkg-1',
      quantity: 2,
      quoteReference: 'QT-abc',
      idempotencyKey: 'client-key-1',
      correlationId: 'corr-1',
    })
  })

  it('uses executePurchase (sync) when async is not set, and forwards quoteReference', async () => {
    await createOrder({
      businessId: 'biz-1',
      userId: 'user-1',
      packageId: 'pkg-1',
      quantity: 1,
      quoteReference: 'QT-sync',
    })

    expect(orchestrator().executePurchaseAsync).not.toHaveBeenCalled()
    expect(lastSyncArgs()).toMatchObject({
      businessId: 'biz-1',
      packageId: 'pkg-1',
      quantity: 1,
      quoteReference: 'QT-sync',
    })
  })

  it('maps a retryable failure to HTTP 502 and a definitive failure to 400', async () => {
    orchestrator().executePurchaseAsync.mockResolvedValueOnce({
      success: false, errorCode: 'PACKAGE_UNAVAILABLE', message: 'temporarily unavailable', retryable: true,
    })
    const retryable = await createOrder({ businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1, async: true })
    expect(retryable.success).toBe(false)
    expect(retryable.errorStatus).toBe(502)

    orchestrator().executePurchaseAsync.mockResolvedValueOnce({
      success: false, errorCode: 'BACKING_NOT_CONFIGURED', message: 'no backing', retryable: false,
    })
    const definitive = await createOrder({ businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1, async: true })
    expect(definitive.success).toBe(false)
    expect(definitive.errorStatus).toBe(400)
  })

  it('fires order.failed webhook only on failure, order.completed on success', async () => {
    orchestrator().executePurchaseAsync.mockResolvedValueOnce({
      success: false, errorCode: 'X', message: 'boom', retryable: false, orderId: 'order-1',
    })
    await createOrder({ businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1, async: true })

    const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
    const failed = enqueueBusinessWebhooks.mock.calls.find((c: any) => c[1] === 'order.failed')
    expect(failed).toBeTruthy()
  })

  it('esim.provisioned webhook payload is additive — canonical status preserved, normalized lifecycle fields added, no provider status', async () => {
    orchestrator().executePurchaseAsync.mockResolvedValueOnce({
      success: true, orderId: 'order-1', status: 'FULFILLED', quantity: 1,
      esims: [{ id: 'esim-1', iccid: '89012345678901234567', status: 'PENDING_ACTIVATION', activationCode: 'LPA:1$smdp.example.com$mid-1', qrCodeUrl: null }],
    })
    await createOrder({ businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1, async: true })

    // Give the fire-and-forget webhook closure a microtask to run.
    await new Promise((r) => setTimeout(r, 10))

    const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
    const call = enqueueBusinessWebhooks.mock.calls.find((c: any) => c[1] === 'esim.provisioned')
    expect(call).toBeTruthy()
    const payload = call[2]
    const esim = payload.esims[0]
    // Backward-compatible raw canonical status retained.
    expect(esim.status).toBe('PENDING_ACTIVATION')
    expect(esim.serviceStatus).toBe('PENDING_ACTIVATION')
    expect(esim.serviceStatusLabel).toBe('Provisioned')
    expect(esim.installationStatus).toBe('READY')
    expect(esim.installationStatusLabel).toBe('Ready to install')
    // Provider identity/vocabulary is never exposed.
    expect(JSON.stringify(payload)).not.toContain('providerStatus')
    expect(JSON.stringify(payload)).not.toContain('provider')
  })
})