import { describe, it, expect, vi, afterEach } from 'vitest'
import { StandardProviderConnector } from './standard-connector'

function okJson(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

function makeConnector(activationPath = '/activate', fieldMappings: Record<string, string> = {}) {
  return new StandardProviderConnector({
    providerId: 'std-1',
    name: 'Standard',
    apiBaseUrl: 'https://api.example.com',
    apiToken: 'tok',
    activationPath,
    statusPath: '/status/{id}',
    fieldMappings,
    tokenPlacement: 'HEADER',
    authType: 'bearer_token',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StandardProviderConnector.activateESIM — canonical result contract', () => {
  it('returns definitive success + ICCID from field mapping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ transaction_id: 't1', iccid: '89012345678901234567', status: 'ACTIVATED' })))
    const c = makeConnector('/a', { iccid: 'iccid' })
    const result = await c.activateESIM({ planId: 'sku-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(true)
    expect(result.data?.iccids).toEqual(['89012345678901234567'])
    expect(result.data?.activationId).toBe('t1')
  })

  it('does NOT emit unsafe terminal success for empty ICCIDs: terminal status → AMBIGUOUS upstreamConfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ id: 'o1', status: 'ACTIVATED' })))
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'sku-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_ICCIDS')
    expect(result.error?.details?.ambiguous).toBe(true)
    expect(result.error?.details?.upstreamConfirmed).toBe(true)
    expect(result.error?.details?.providerOrderId).toBe('o1')
  })

  it('converts an explicit pending status to canonical PENDING success (async polling safe)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ id: 'o2', status: 'pending' })))
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'sku-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(true)
    expect(result.data?.iccids).toEqual([])
    expect(result.data?.status).toBe('PENDING')
    expect(result.data?.activationId).toBe('o2')
  })

  it('reports a DEFINITIVE NO_ICCIDS for an explicit failed status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ id: 'o3', status: 'FAILED' })))
    const c = makeConnector()
    const result = await c.activateESIM({ planId: 'sku-1', quantity: 1, subscriber: { email: 'e@x.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_ICCIDS')
    expect(result.error?.details?.ambiguous).not.toBe(true)
  })
})