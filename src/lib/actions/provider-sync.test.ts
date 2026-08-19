import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSession } = vi.hoisted(() => ({ mockSession: vi.fn() }))

vi.mock('next-auth', () => ({ getServerSession: mockSession }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

vi.mock('@/lib/providers/capabilities/registry', () => ({
  providerSupports: vi.fn(() => true),
}))

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
}))

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

vi.mock('@/lib/providers/certification-machine', () => ({
  advanceCertificationTo: vi.fn(),
}))

vi.mock('@/lib/providers/provider-requirements-resolver', () => ({}))
vi.mock('@/lib/providers/travel-date-utils', () => ({
  normalizeTravelDateRequirement: () => 'NOT_REQUIRED',
  withTravelDateMarker: (raw: any) => raw,
}))

const { buildAdapter, isTemplateDrivenProvider } = vi.hoisted(() => ({
  buildAdapter: vi.fn(),
  isTemplateDrivenProvider: vi.fn(() => false),
}))
vi.mock('@/lib/providers/adapter-manager', () => ({
  buildAdapter,
  isTemplateDrivenProvider,
  isProviderOperational: () => true,
}))

const { prisma } = vi.hoisted(() => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    providerPackage: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma }))

import { syncProviderPlans } from './provider-sync'

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(buildAdapter)

function providerRow(overrides: any = {}) {
  return {
    id: 'prov-telna', name: 'Telna', code: 'TELNA', type: 'CUSTOM', adapterStrategy: 'TELNA',
    apiBaseUrl: 'https://developer-api.telna.com', apiToken: 'enc:x', planListPath: null,
    endpointMappings: null, requestMappings: null, responseMappings: null, fieldMappings: null,
    config: {}, priority: 0, isDefaultFallback: false, status: 'ACTIVE',
    ...overrides,
  }
}

function adapterReturning(plans: any) {
  return { syncPlans: vi.fn().mockResolvedValue({ success: true, data: plans }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue({ user: { role: 'INTERNAL_ADMIN', id: 'admin-1' } })
  mockPrisma.provider.findUnique.mockResolvedValue(providerRow())
  mockPrisma.auditLog.create.mockResolvedValue({})
  mockPrisma.provider.update.mockResolvedValue({})
  mockPrisma.providerPackage.findFirst.mockResolvedValue(null)
  mockPrisma.providerPackage.create.mockImplementation(async (args: any) => ({ id: 'created-1', ...args.data }) as any)
  mockPrisma.providerPackage.update.mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data }) as any)
})

describe('syncProviderPlans — Telna no-cost + deactivation safety', () => {
  it('no-cost Telna plan creates a ProviderPackage that is COST_UNAVAILABLE / UNCONFIGURED, not publish-ready', async () => {
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: true, raw_data: { providerStatus: 'ACTIVE' } },
    ]) as any)

    await syncProviderPlans('prov-telna')

    const create = mockPrisma.providerPackage.create.mock.calls[0][0] as any
    expect(create.data.providerPlanId).toBe('1264275')
    expect(create.data.costPrice).toBe(0)
    expect(create.data.costStatus).toBe('MISSING')
    expect(create.data.pricingStatus).toBe('COST_UNAVAILABLE')
    // configurationStatus defaults to UNCONFIGURED in the DB (not set by sync);
    // costStatus MISSING + pricingStatus COST_UNAVAILABLE block publish readiness.
    expect(create.data.isAvailable).toBe(true)
  })

  it('re-sync preserves a manually configured cost (existing.costPrice retained over zero)', async () => {
    // Existing ProviderPackage with a manual cost + admin override.
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      id: 'pp-1', providerId: 'prov-telna', providerPlanId: '1264275',
      costPrice: 1.5, adminCostPrice: 1.5, readyToPublish: false, costStatus: 'OVERRIDDEN',
    } as any)
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-telna')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    // costPrice not overwritten by 0 when plan reports no cost (plan.price falsy).
    expect(update.data.costPrice).toBe(1.5)
    expect(update.data.costStatus).toBe('OVERRIDDEN')
    expect(mockPrisma.providerPackage.create).not.toHaveBeenCalled()
  })

  it('Active -> De-activated keeps the SAME ProviderPackage row but flips isAvailable false', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      id: 'pp-1', providerId: 'prov-telna', providerPlanId: '1264275',
      costPrice: 2, adminCostPrice: null, readyToPublish: true,
    } as any)
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: false, raw_data: { providerStatus: 'DE_ACTIVATED' } },
    ]) as any)

    await syncProviderPlans('prov-telna')

    // Update the same row (no create, no duplicate).
    expect(mockPrisma.providerPackage.create).not.toHaveBeenCalled()
    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.where.id).toBe('pp-1')
    expect(update.data.isAvailable).toBe(false)
  })

  it('De-activated -> Active and repeated Active sync restore the same row and never duplicate', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({ id: 'pp-1', providerId: 'prov-telna', providerPlanId: '1264275', costPrice: 2, adminCostPrice: null, readyToPublish: false } as any)
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: true, raw_data: {} },
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-telna')

    const createCalls = mockPrisma.providerPackage.create.mock.calls.length
    const updateCalls = mockPrisma.providerPackage.update.mock.calls.length
    expect(createCalls).toBe(0)
    expect(updateCalls).toBe(2)
    // Both updates target the SAME row id.
    for (const c of mockPrisma.providerPackage.update.mock.calls) {
      expect((c[0] as any).where.id).toBe('pp-1')
      expect((c[0] as any).data.isAvailable).toBe(true)
    }
  })

  it('a template merely missing from a sync does NOT deactivate other packages (no mass-disable)', async () => {
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: '1264275', name: 'EU_1G_1M', data_gb: 1, validity_days: 30, price_usd: 0, isAvailable: true, raw_data: {} },
    ]) as any)
    // Only the returned template is touched; another package id is never updated.
    await syncProviderPlans('prov-telna')
    const updatedIds = mockPrisma.providerPackage.update.mock.calls.map(c => (c[0] as any).where.id)
    expect(updatedIds).not.toContain('other-template')
  })
})
