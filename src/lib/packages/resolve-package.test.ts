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
  // The public SKU derives country/region from ProviderPackage (nested) but the
  // serializers flatten providerPackage.country/region into derivePublicSku.
  // The resolver MUST flatten candidates the same way — this is the exact
  // staging failure class (OS-USA-12GB-30D-… vs OS-XX-…).
  const flat = (c: any) => derivePublicSku({
    id: c.id,
    providerPackageId: c.providerPackageId,
    country: c.providerPackage?.country,
    region: c.providerPackage?.region,
    dataGB: c.dataGB,
    validityDays: c.validityDays,
  })

  it('resolves a persisted (legacy provider-code) SKU by direct lookup — existing integrations keep working', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage() as any)
    const r = await resolvePackageIdentifier({ sku: 'OS-AIRHUB-XX-35GB-30D-AJ33VU' })
    expect(r).not.toBeNull()
    expect(r!.resolvedBy).toBe('sku')
    expect(r!.package.id).toBe('retail-1')
  })

  it('resolves the NEW provider-neutral public SKU when the persisted SKU is legacy and geography is present (regression: OS-USA vs OS-XX)', async () => {
    const candidate = { id: 'retail-1', providerPackageId: 'pp-airhub-000', dataGB: 35, validityDays: 30, providerPackage: { country: 'USA', region: 'USA' } }
    const publicSku = flat(candidate)
    // Non-XX geography must be encoded in the derived SKU.
    expect(publicSku.startsWith('OS-USA-35GB-30D-')).toBe(true)
    // Direct lookup misses (client sent the derived public SKU).
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    // Candidate scan finds exactly one deriving package.
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([candidate] as any)
    // Full fetch returns the package.
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage() as any)

    const r = await resolvePackageIdentifier({ sku: publicSku })
    expect(r).not.toBeNull()
    expect(r!.package.id).toBe('retail-1')
    expect(r!.resolvedBy).toBe('sku')
  })

  it('resolves the neutral public SKU when the match lies beyond the first N candidate rows (no bounded-window cutoff)', async () => {
    const target = { id: 'retail-target', providerPackageId: 'pp-target-0001', dataGB: 12, validityDays: 30, providerPackage: { country: 'USA', region: 'USA' } }
    const publicSku = flat(target)
    // 120 decoy candidates, target placed LAST — far beyond any 50/100 window.
    const decoys = Array.from({ length: 120 }, (_, i) => ({
      id: `retail-${i}`,
      providerPackageId: `pp-decoy-${String(i).padStart(4, '0')}`,
      dataGB: 12 + (i % 5),
      validityDays: 30,
      providerPackage: { country: 'XX', region: null },
    }))
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([...decoys, target] as any)
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage({ id: 'retail-target' }) as any)

    const r = await resolvePackageIdentifier({ sku: publicSku })
    expect(r).not.toBeNull()
    expect(r!.package.id).toBe('retail-target')
  })

  it('fails closed (null) when the derived public SKU is ambiguous (multiple candidates)', async () => {
    const candidate = { id: 'retail-1', providerPackageId: 'pp-1', dataGB: 35, validityDays: 30, providerPackage: { country: 'ZA', region: null } }
    const publicSku = flat(candidate)
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([
      { ...candidate },
      { ...candidate, id: 'retail-2' },
    ] as any)
    const r = await resolvePackageIdentifier({ sku: publicSku })
    expect(r).toBeNull()
  })

  it('excludes inactive packages from the neutral fallback candidate scope', async () => {
    const candidate = { id: 'retail-1', providerPackageId: 'pp-1', dataGB: 35, validityDays: 30, providerPackage: { country: 'ZA', region: null } }
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([candidate] as any)
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage({ id: 'retail-1' }) as any)

    const r = await resolvePackageIdentifier({ sku: flat(candidate) })
    // Query must scope to active catalog rows (default activeFilter).
    expect(mockPrisma.eSIMPackage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    }))
    // Inactive rows are excluded by the WHERE (the returned row is active and resolves).
    expect(r).not.toBeNull()
  })

  it('keeps hiddenFromCatalog/archivedAt behavior consistent with the resolver contract (only isActive+source gate the fallback scan)', async () => {
    // The resolver's identity lookup has always been gated by isActive(+source for
    // the neutral fallback), NOT by hiddenFromCatalog/archivedAt — matching the
    // direct persisted-sku lookup contract. An active-but-hidden candidate still
    // resolves (identity lookup ≠ purchase eligibility); purchase surfaces gate it.
    const candidate = {
      id: 'retail-hidden', providerPackageId: 'pp-h-1', dataGB: 35, validityDays: 30,
      providerPackage: { country: 'GB', region: 'GB' },
    }
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null) // sku miss
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([candidate] as any)
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(fullPackage({ id: 'retail-hidden', hiddenFromCatalog: true, archivedAt: new Date() }) as any)
    const r = await resolvePackageIdentifier({ sku: flat(candidate) })
    expect(r).not.toBeNull()
    expect(r!.package.id).toBe('retail-hidden')
  })

  it('unknown public SKU returns null as before', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValueOnce(null)
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([])
    const r = await resolvePackageIdentifier({ sku: 'OS-ZZ-99GB-99D-AAAAAA' })
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