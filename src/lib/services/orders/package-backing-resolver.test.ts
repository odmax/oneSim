import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPPFindUnique, mockPPFindMany, mockBindingFindMany } = vi.hoisted(() => ({
  mockPPFindUnique: vi.fn(),
  mockPPFindMany: vi.fn(),
  mockBindingFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockPPFindUnique, findMany: mockPPFindMany },
    eSIMPackageProviderBinding: { findMany: mockBindingFindMany },
  },
}))

import { resolvePackageBacking } from './package-backing-resolver'

function binding(providerPackageId: string, providerId: string, priority: number, valid = true) {
  return {
    priority,
    providerPackage: valid ? {
      id: providerPackageId,
      providerId,
      configurationStatus: 'CONFIGURED',
      publishStatus: 'PUBLISHED',
      sellingPrice: { toString: () => '8' },
      costPrice: { toString: () => '4' },
      provider: { id: providerId, name: 'Prov ' + providerId, status: 'ACTIVE' },
    } : null,
    ...(valid ? {} : {}),
  }
}

describe('resolvePackageBacking — custom vs standard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('CPB-UI-15: standard package with providerPackageId resolves as BOUND', async () => {
    mockPPFindUnique.mockResolvedValue({ id: 'pp-1', providerId: 'prov-1', providerPlanId: 'pl-1', isAvailable: true })
    const result = await resolvePackageBacking({ id: 'retail-1', providerPackageId: 'pp-1' })
    expect(result.kind).toBe('BOUND')
    if (result.kind === 'BOUND') {
      expect(result.backing.providerPackageId).toBe('pp-1')
    }
    // BOUND path must NOT consult the binding model.
    expect(mockBindingFindMany).not.toHaveBeenCalled()
  })

  it('CPB-UI-14: created custom package with bindings resolves as CUSTOM (priority-ordered)', async () => {
    mockBindingFindMany.mockResolvedValue([
      binding('pp-a', 'prov-a', 1),
      binding('pp-b', 'prov-b', 2),
    ])
    const result = await resolvePackageBacking({ id: 'custom-1', providerPackageId: null })
    expect(result.kind).toBe('CUSTOM')
    if (result.kind === 'CUSTOM') {
      expect(result.backings).toHaveLength(2)
      expect(result.backings[0].providerPackageId).toBe('pp-a')
      expect(result.backings[1].providerPackageId).toBe('pp-b')
      expect(result.backings[0].priority).toBe(1)
    }
  })

  it('custom package with a deactivated/ineligible binding is filtered out', async () => {
    mockBindingFindMany.mockResolvedValue([
      binding('pp-ok', 'prov-a', 1, true),
      binding('pp-disabled', 'prov-b', 2, false), // providerPackage missing ⇒ filtered
    ])
    const result = await resolvePackageBacking({ id: 'custom-1', providerPackageId: null })
    expect(result.kind).toBe('CUSTOM')
    if (result.kind === 'CUSTOM') {
      expect(result.backings.map(b => b.providerPackageId)).toEqual(['pp-ok'])
    }
  })

  it('custom package with zero usable bindings → NO backing kind', async () => {
    mockBindingFindMany.mockResolvedValue([])
    const result = await resolvePackageBacking({ id: 'custom-empty', providerPackageId: null, providerId: null, providerPlanId: null })
    expect(result.kind).toBe('NONE')
  })
})
