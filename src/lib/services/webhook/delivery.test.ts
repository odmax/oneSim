import { describe, it, expect } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/services/jobs/queue', () => ({ enqueueJob: vi.fn() }))

import { buildPurchaseWebhookPayload } from './delivery'

const ICCID = '89012345678901234567'

function purchase(overrides: any = {}) {
  return {
    id: 'ord-1',
    status: 'FULFILLED',
    quantity: 1,
    totalAmount: '10.00',
    package: { name: '5GB Plan' },
    esims: [{ iccid: ICCID, status: 'PENDING_ACTIVATION' }],
    ...overrides,
  }
}

describe('legacy webhook payload redaction', () => {
  it('masks full ICCIDs in the delivered payload (no full ICCID leaks)', () => {
    const payload = buildPurchaseWebhookPayload('esim.provisioned', purchase())
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(ICCID)
    expect(payload.data.esims[0].iccid).toBe('8901••••4567')
    expect(payload.data.esims[0].status).toBe('PENDING_ACTIVATION')
    // Wire shape remains compatible (event/timestamp/data + order meta).
    expect(payload.event).toBe('esim.provisioned')
    expect(payload.data.orderId).toBe('ord-1')
    expect(payload.data.packageName).toBe('5GB Plan')
  })

  it('never includes activation codes or provider payloads', () => {
    const payload = buildPurchaseWebhookPayload('esim.provisioned', purchase({
      esims: [{ iccid: ICCID, status: 'ACTIVE', activationCode: 'LPA:1$smdp.example$SECRET-1234', providerResponse: { token: 'abc' } }],
    }))
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('LPA:')
    expect(serialized).not.toContain('SECRET-1234')
    expect(serialized).not.toContain('abc')
  })
})