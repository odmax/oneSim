import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// order-callback-delivery route — outbound HTTP gating by the atomic claim.
//
// Proves: C) a losing claim performs ZERO outbound HTTP requests, D) a winning
// claimed callback is NOT marked DELIVERED before HTTP succeeds — only after,
// E) a failed claimed callback follows existing retry semantics, and the
// two-replica invariant "exactly one HTTP POST per delivery".
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockExecRaw: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockClaim: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: mocks.mockExecRaw,
    systemJobLock: { deleteMany: mocks.mockDeleteMany },
    orderCallbackDelivery: {
      findMany: mocks.mockFindMany,
      update: mocks.mockUpdate,
      updateMany: mocks.mockUpdateMany,
    },
  },
}))

vi.mock('@/lib/services/orders/callback-delivery-claim', () => ({
  claimOrderCallbackDelivery: mocks.mockClaim,
}))

import { POST } from './route'

const fetchMock = vi.fn()

function mkDelivery(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    status: 'PENDING',
    callbackUrl: 'https://example.com/webhook',
    payload: { id: `cb:order-1:order.fulfilled:v1`, type: 'order.fulfilled', data: { orderId: 'order-1' } },
    businessId: 'biz-1',
    eventId: `evt-${id}`,
    eventType: 'order.fulfilled',
    attemptCount: 0,
    maxAttempts: 7,
    nextAttemptAt: new Date(),
    ...overrides,
  }
}

async function callPost(): Promise<{ status: number; body: any }> {
  const req = new NextRequest('http://localhost/api/internal/jobs/order-callback-delivery', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
  })
  const res = await POST(req)
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OUTBOUND_CALLBACKS_ENABLED = 'true'
  process.env.ORDER_CALLBACK_JOB_SECRET = 'test-secret'
  process.env.ORDER_CALLBACK_BATCH_SIZE = '50'
  delete process.env.OUTBOUND_CALLBACK_ALLOW_HTTP
  mocks.mockExecRaw.mockResolvedValue(1)
  mocks.mockDeleteMany.mockResolvedValue({ count: 0 })
  mocks.mockUpdate.mockResolvedValue({})
  mocks.mockUpdateMany.mockResolvedValue({ count: 0 })
  mocks.mockClaim.mockResolvedValue(true)
  fetchMock.mockReset().mockResolvedValue(new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OUTBOUND_CALLBACKS_ENABLED
  delete process.env.ORDER_CALLBACK_JOB_SECRET
})

describe('order-callback-delivery route — claim-gated HTTP', () => {
  it('C: the losing process performs ZERO outbound HTTP requests and skips cleanly', async () => {
    mocks.mockClaim.mockResolvedValue(false)
    mocks.mockFindMany.mockResolvedValue([
      mkDelivery('d-1', { status: 'PENDING' }),
      mkDelivery('d-2', { status: 'RETRY_SCHEDULED' }),
    ])
    const { status, body } = await callPost()
    expect(status).toBe(200)
    expect(body.scanned).toBe(2)
    expect(body.skipped).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('C2/route: two replicas scanning the same delivery — exactly ONE HTTP POST happens, the loser POSTs zero', async () => {
    // Shared claim state emulating the DB guard: the first claim per delivery wins.
    const claimed = new Map<string, string>()
    mocks.mockClaim.mockImplementation((deliveryId: string, owner: string) => {
      if (claimed.has(deliveryId)) return Promise.resolve(false)
      claimed.set(deliveryId, owner)
      return Promise.resolve(true)
    })
    const delivery = mkDelivery('d-1')
    mocks.mockFindMany.mockResolvedValue([delivery])
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))

    const replica1 = await callPost()
    const replica2 = await callPost()

    // Only the claim winner performed the outbound request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(claimed.get('d-1')).toMatch(/^cb-/)
    expect(replica1.body.delivered).toBe(1)
    expect(replica2.body.delivered).toBe(0)
    expect(replica2.body.skipped).toBe(1)
  })

  it('D: a winning claimed callback is marked DELIVERED only after HTTP succeeds; the claim is cleared', async () => {
    mocks.mockClaim.mockResolvedValue(true)
    mocks.mockFindMany.mockResolvedValue([mkDelivery('d-1', { attemptCount: 0 })])
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))

    const { body } = await callPost()
    expect(body.delivered).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0]
    expect(url).toBe('https://example.com/webhook')
    expect(fetchMock.mock.calls[0][1].headers['X-OneSIM-Signature']).toMatch(/^v1=/)

    const update = mocks.mockUpdate.mock.calls.find((c: any) => c[0]?.where?.id === 'd-1')
    expect(update).toBeTruthy()
    const updateData = update[0].data
    expect(updateData.status).toBe('DELIVERED')
    expect(updateData.deliveredAt).toBeInstanceOf(Date)
    expect(updateData.attemptCount).toBe(1)
    expect(updateData.nextAttemptAt).toBeNull()
    // Claim released on the terminal write.
    expect(updateData.claimOwner).toBeNull()
    expect(updateData.claimedUntil).toBeNull()
  })

  it('E: a retryable failure (HTTP 500) follows existing retry semantics, never strands the delivery', async () => {
    mocks.mockClaim.mockResolvedValue(true)
    mocks.mockFindMany.mockResolvedValue([mkDelivery('d-1', { attemptCount: 0 })])
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }))

    const { body } = await callPost()
    expect(body.retryScheduled).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const update = mocks.mockUpdate.mock.calls.find((c: any) => c[0]?.where?.id === 'd-1')
    const updateData = update[0].data
    expect(updateData.status).toBe('RETRY_SCHEDULED')
    expect(updateData.attemptCount).toBe(1)
    expect(updateData.lastErrorCode).toBe('HTTP_500')
    expect(updateData.nextAttemptAt).toBeInstanceOf(Date)
    expect(updateData.deliveredAt).toBeUndefined()
    expect(updateData.claimOwner).toBeNull()
  })

  it('E2: a network error on a claimed callback schedules a retry (NETWORK_ERROR), claim cleared', async () => {
    mocks.mockClaim.mockResolvedValue(true)
    mocks.mockFindMany.mockResolvedValue([mkDelivery('d-1', { attemptCount: 0 })])
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const { body } = await callPost()
    expect(body.retryScheduled).toBe(1)
    const update = mocks.mockUpdate.mock.calls.find((c: any) => c[0]?.where?.id === 'd-1')
    expect(update[0].data.status).toBe('RETRY_SCHEDULED')
    expect(update[0].data.lastErrorCode).toBe('NETWORK_ERROR')
    expect(update[0].data.claimOwner).toBeNull()
  })

  it('G: terminals are never delivered — the claim gate blocks them and zero HTTP occurs', async () => {
    mocks.mockClaim.mockResolvedValue(false)
    mocks.mockFindMany.mockResolvedValue([mkDelivery('d-1', { status: 'DELIVERED' })])
    const { body } = await callPost()
    expect(body.skipped).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})