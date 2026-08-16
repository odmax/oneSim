import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => {
  const eSIMUpdate = vi.fn()
  const usageCreate = vi.fn()
  return {
    prisma: {
      eSIM: { findUnique: vi.fn(), update: eSIMUpdate },
      usageRecord: { create: usageCreate },
      $transaction: vi.fn(async (fn: any) => {
        await fn({ eSIM: { update: eSIMUpdate }, usageRecord: { create: usageCreate } })
      }),
    },
  }
})

vi.mock('@/lib/services/esims/sync-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/esims/sync-lookup')>()
  return { ...actual, buildProviderConnector: vi.fn() }
})

const { prisma } = await import('@/lib/prisma')
const { buildProviderConnector } = await import('@/lib/services/esims/sync-lookup')
const { syncESIMUsage } = await import('./sync-usage')

const mockPrisma = vi.mocked(prisma)
const mockBuildConnector = vi.mocked(buildProviderConnector)

function makeEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: '8944501234567890123',
    providerActivationId: 'esim-uuid-1',
    providerResponse: null,
    status: 'ACTIVE',
    purchase: { package: { providerId: 'p-1', providerPlanId: 'pkg-uuid-77', providerPackageId: 'pp-1' } },
    ...overrides,
  }
}

/** US-Matrix-shaped connector: resolves via providerResponse / package identity. */
function usageConnector(overrides: any = {}) {
  return {
    capabilities: { statusLookup: true, usageLookup: true },
    resolveUsageLookup: vi.fn((esim: any) => {
      const persisted = esim.providerResponse && typeof esim.providerResponse === 'object' ? esim.providerResponse.packageEsimId : undefined
      if (typeof persisted === 'string' && persisted) return persisted
      if (esim.providerActivationId) {
        const bundle: any = { providerActivationId: esim.providerActivationId }
        if (esim.providerPlanId) bundle.providerPlanId = esim.providerPlanId
        if (esim.providerPackageId) bundle.providerPackageId = esim.providerPackageId
        return bundle
      }
      return null
    }),
    getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: 'assoc-uuid-9', dataUsedMB: 400, dataTotalMB: 10240, dataRemainingMB: 9840, providerPackageEsimId: 'assoc-uuid-9' } }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim() as any)
  mockPrisma.eSIM.update.mockResolvedValue({} as any)
  mockPrisma.usageRecord.create.mockResolvedValue({} as any)
  mockBuildConnector.mockResolvedValue(usageConnector() as any)
})

describe('syncESIMUsage — provider-neutral discovery + persistence', () => {
  it('persists a discovered packageEsimId into providerResponse without overwriting existing keys', async () => {
    const esim = makeEsim({ providerResponse: { providerEsimId: 'esim-uuid-1', evidence: 'x' } })
    mockPrisma.eSIM.findUnique.mockResolvedValue(esim as any)

    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(true)
    expect(r.dataUsedMB).toBe(400)

    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.providerResponse).toEqual({
      providerEsimId: 'esim-uuid-1',
      evidence: 'x',
      packageEsimId: 'assoc-uuid-9',
    })
  })

  it('passes the structured discovery bundle (provider UUID + package identity) to getUsage on first sync', async () => {
    const connector = usageConnector()
    mockBuildConnector.mockResolvedValue(connector as any)

    await syncESIMUsage('esim-1')
    const bundle = connector.getUsage.mock.calls[0][0]
    expect(bundle).toEqual({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77', providerPackageId: 'pp-1' })
  })

  it('second sync uses the persisted packageEsimId — no re-discovery', async () => {
    const esim = makeEsim({ providerResponse: { providerEsimId: 'esim-uuid-1' } })
    mockPrisma.eSIM.findUnique.mockImplementation(async () => esim as any)
    const connector = usageConnector()
    mockBuildConnector.mockResolvedValue(connector as any)
    // Simulate canonical persistence: after the first sync the row carries the
    // discovered association id, which the connector resolver reads back.
    mockPrisma.eSIM.update.mockImplementation(async ({ data }: any) => {
      if (data.providerResponse) (esim as any).providerResponse = data.providerResponse
      return esim
    })

    await syncESIMUsage('esim-1')
    expect((esim as any).providerResponse.packageEsimId).toBe('assoc-uuid-9')

    await syncESIMUsage('esim-1')
    // Second sync resolves the persisted id (fast path) instead of the bundle.
    expect(connector.getUsage.mock.calls[1][0]).toBe('assoc-uuid-9')
    expect(connector.getUsage.mock.calls[0][0]).toEqual({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77', providerPackageId: 'pp-1' })
  })

  it('treats an ambiguous association as a clean skip (no persistence, no failure)', async () => {
    const connector = usageConnector({
      getUsage: vi.fn().mockResolvedValue({ success: false, error: { code: 'AMBIGUOUS_ASSOCIATION', message: 'multiple associations, no unique match' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(true)
    expect(r.skipped).toBe(true)
    expect(r.skipReason).toBe('AMBIGUOUS_ASSOCIATION')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
    expect(mockPrisma.usageRecord.create).not.toHaveBeenCalled()
  })

  it('treats a missing association as a clean skip', async () => {
    const connector = usageConnector({
      getUsage: vi.fn().mockResolvedValue({ success: false, error: { code: 'NO_ASSOCIATION', message: 'no packageEsims' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(true)
    expect(r.skipped).toBe(true)
    expect(r.skipReason).toBe('NO_ASSOCIATION')
  })

  it('skips cleanly when the connector does not declare usage lookup', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { usageLookup: false }, getUsage: vi.fn() } as any)
    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(true)
    expect(r.skipped).toBe(true)
    expect(r.skipReason).toBe('CAPABILITY_NOT_SUPPORTED')
  })

  it('propagates a real provider failure (never a skip)', async () => {
    const connector = usageConnector({
      getUsage: vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500', message: 'provider boom' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(false)
    expect(r.error).toBe('provider boom')
  })
})
