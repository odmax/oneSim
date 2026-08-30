import { describe, it, expect, vi, afterEach } from 'vitest'
import { HeaderTokenRestConnector } from './header-token-rest-connector'

function okJson(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

function makeConnector() {
  return new HeaderTokenRestConnector('ht-1', 'Header Token', {
    apiBaseUrl: 'https://api.example.com',
    apiToken: 'tok',
  })
}

function stubFourStepFlow(activationData: any) {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(okJson({ id: 'sub-1', subscriber_id: 'sub-1' })) // subscriber
    .mockResolvedValueOnce(okJson({ id: 'addr-1', address_id: 'addr-1' })) // address
    .mockResolvedValueOnce(okJson({ id: 'a-1' })) // validate
    .mockResolvedValueOnce(okJson(activationData))) // activate
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HeaderTokenRestConnector.activateESIM — canonical result contract', () => {
  it('returns definitive success + ICCID on activation', async () => {
    stubFourStepFlow({ id: 'act-1', activation_id: 'act-1', iccid: '89012345678901234567', status: 'ACTIVE' })
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'plan-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(true)
    expect(result.data?.iccids).toEqual(['89012345678901234567'])
    expect(result.data?.activationId).toBe('act-1')
  })

  it('keeps a default PENDING activation with zero ICCIDs as canonical pending (not terminal success)', async () => {
    stubFourStepFlow({ id: 'act-2', activation_id: 'act-2' })
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'plan-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(true)
    expect(result.data?.iccids).toEqual([])
    expect(result.data?.status).toBe('PENDING')
    expect(result.data?.activationId).toBe('act-2')
  })

  it('never reports terminal success with empty ICCIDs: explicit ACTIVE + empty → AMBIGUOUS upstreamConfirmed', async () => {
    stubFourStepFlow({ id: 'act-3', activation_id: 'act-3', status: 'ACTIVE' })
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'plan-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_ICCIDS')
    expect(result.error?.details?.ambiguous).toBe(true)
    expect(result.error?.details?.upstreamConfirmed).toBe(true)
    expect(result.error?.details?.providerOrderId).toBe('act-3')
  })
})