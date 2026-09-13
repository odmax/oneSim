import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPackage: { findUnique: vi.fn(), findMany: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { resolvePackageIdentifier, generateSku } = await import('./resolve-package')
const { derivePublicSku } = await import('@/lib/catalog/public-sku')

const mockPrisma = vi.mocked(prisma)

function fullPackage(overrides: any = {}) {
  return {
    id: 'retail-1',
    sku: 'OS-AIRHUB-XX-35GB-30D-AJ33VU', // legacy persisted (provider-identifying) SKU
    packageCode: 'OS-AIRHUB-XX-35GB-30D-AJ33VU',
    dataGB: 35,
    validityDays: 30,
    providerId: null,
    source: 'CATALOG_PRODUCT',
    isActive: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.provider.findUnique.mockResolvedValue(null)
})

describe('resolvePackageIdentifier — backward-compatible public-SKU resolution', () => {
  it('resolves a persisted (legacy provider-code) SKU by direct lookup — existing integrations keep working', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage() as any)
    const r = await resolvePackageIdentifier({ sku: 'OS-AIRHUB-XX-35GB-30D-AJ33VU' })
    expect(r).not.toBeNull()
    expect(r!.resolvedBy).toBe('sku')
    expect(r!.package.id).toBe('retail-1')
  })

  it('resolves the NEW provider-neutral public SKU even when the persisted SKU is legacy (fallback derivation)', async () => {
    const candidate = { id: 'retail-1', providerPackageId: 'pp-airhub-000', dataGB: 35, validityDays: 30, providerPackage: { country: 'ZA', region: null } }
    const publicSku = derivePublicSku(candidate)
    // Direct lookup misses (client sent the derived public SKU that differs from
    // the legacy persisted value)…
    mockPrisma.eSIMPackage.findUnique
      .mockResolvedValueOnce(null) // sku miss
    // …candidate scan finds exactly one deriving package…
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([candidate] as any)
    // …full fetch returns the package.
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage() as any)

    const r = await resolvePackageIdentifier({ sku: publicSku })
    expect(r).not.toBeNull()
    expect(r!.package.id).toBe('retail-1')
    expect(r!.resolvedBy).toBe('sku')
  })

  it('fails closed (null) when the derived public SKU is ambiguous (multiple candidates)', async () => {
    const candidate = { id: 'retail-1', providerPackageId: 'pp-1', dataGB: 35, validityDays: 30, providerPackage: { country: 'ZA', region: null } }
    const publicSku = derivePublicSku(candidate)
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([
      { ...candidate },
      { ...candidate, id: 'retail-2' },
    ] as any)
    const r = await resolvePackageIdentifier({ sku: publicSku })
    expect(r).toBeNull()
  })

  it('non-public (non OS-) skus never trigger the fallback scan', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null)
    const r = await resolvePackageIdentifier({ sku: 'SOME-SKU' })
    expect(r).toBeNull()
    expect(mockPrisma.eSIMPackage.findMany).not.toHaveBeenCalled()
  })
})

describe('generateSku — provider-neutral generation', () => {
  it.each(['AIRHUB', 'CHOICE', 'TELNA', 'SECRET_PROVIDER_X'])('never embeds the provider code %s', (provider) => {
    const sku = generateSku('Regional 35GB', 35, 30, provider)
    expect(sku.toUpperCase()).not.toContain(provider.toUpperCase().replace(/\s+/g, ''))
    expect(sku).toBe('OS-35GB-30D-REGIONAL-35GB')
  })
})