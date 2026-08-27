import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serializePublicPackage, findForbiddenFields } from '@/lib/api/public-dto'

const ROOT = process.cwd()

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

// Files whose Prisma queries must never combine `select` and `include` on the
// same relation (Prisma Client rejects this at runtime, even though mocked
// tests pass). These are the Admin Provider/Product Catalog + Custom Package
// Builder query-bearing files.
const QUERY_FILES = [
  'src/app/admin/packages/page.tsx',
  'src/app/admin/provider-catalog/page.tsx',
  'src/app/admin/provider-catalog/custom/new/page.tsx',
  'src/lib/packages/query-purchasable.ts',
  'src/lib/services/orders/package-backing-resolver.ts',
  'src/lib/services/custom-package/custom-package.ts',
  'src/lib/services/custom-package/eligible-providers.ts',
  'src/lib/actions/custom-package.ts',
  'src/app/api/v1/esims/[esimId]/share/route.ts',
]

/**
 * Structural guard: Prisma does not allow `select` and `include` as siblings on
 * the same relation object. This catches that runtime break that unit tests
 * with mocked Prisma never see (mocks skip Prisma Client validation).
 */
function findSiblingSelectInclude(src: string): string[] {
  const found: string[] = []
  // A relation object like: rel: { select: { ... }, include: { ... } }
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*?)\s*:\s*\{\s*select\s*:\s*\{[^{}]*\}\s*,\s*include\s*:/g)) {
    found.push(`${m[1]}: select+include sibling`)
  }
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*?)\s*:\s*\{\s*include\s*:\s*\{[^{}]*\}\s*,\s*select\s*:/g)) {
    found.push(`${m[1]}: include+select sibling`)
  }
  return found
}

describe('CPB-UI — admin UI visibility', () => {
  it('CPB-UI-1: /admin/provider-catalog exposes Create Custom Package', () => {
    const src = read('src/app/admin/provider-catalog/page.tsx')
    expect(src).toContain('Create Custom Package')
    expect(src).toContain('/admin/provider-catalog/custom/new')
  })

  it('CPB-UI-2: create page renders with title + form', () => {
    const src = read('src/app/admin/provider-catalog/custom/new/page.tsx')
    expect(src).toContain('Create Custom Package')
    expect(src).toContain('<CustomPackageForm')
  })
})

describe('CPB-UI-18 — admin catalog CUSTOM badge', () => {
  it('admin packages page renders a CUSTOM indicator for multi-provider packages', () => {
    const src = read('src/app/admin/packages/page.tsx')
    expect(src).toContain('CUSTOM')
    expect(src).toContain('providerBindings')
    expect(src).toContain('Primary:')
  })
})

describe('CPB-UI-19 — business/public API never exposes provider identities/backing list', () => {
  it('public package DTO allowlist has no provider identity or backing fields', () => {
    const src = read('src/lib/api/public-dto.ts')
    // The PublicPackageDTO must not expose provider identity or binding internals.
    expect(src).not.toMatch(/providerName:/)
    expect(src).not.toMatch(/providerPlanId:/)
    expect(src).not.toMatch(/providerId:/)
    expect(src).not.toMatch(/providerBindings:/)
    expect(src).not.toMatch(/rawData:/)
  })

  it('public package serialization of a custom package leaks no backing/provider fields', () => {
    const dto = serializePublicPackage(
      { id: 'custom-1', sku: 'SKU1', packageCode: 'PC1', displayName: 'Custom', name: 'Custom', customerDescription: null, description: null, dataGB: 10, validityDays: 30, priceUSD: 29.99, currency: 'USD', productType: 'NEW_ESIM', isActive: true, requiresTravelDate: false, source: 'CATALOG_PRODUCT' },
      undefined,
    )
    const forbidden = findForbiddenFields(dto)
    expect(forbidden).toHaveLength(0)
    // No provider identity key present in serialized DTO.
    expect(Object.keys(dto)).not.toContain('providerName')
    expect(Object.keys(dto)).not.toContain('providerBindings')
    expect(Object.keys(dto)).not.toContain('providerRawData')
  })
})

describe('Prisma query structural integrity (select+include sibling guard)', () => {
  it.each(QUERY_FILES)('%s has no relation combining select+include on the same object', (file) => {
    const src = read(file)
    const conflicts = findSiblingSelectInclude(src)
    expect(conflicts).toEqual([])
  })
})

describe('CPB-UI — two creation modes', () => {
  it('custom/new form presents a mode selector with both creation modes', () => {
    const src = read('src/app/admin/provider-catalog/custom/new/CustomPackageForm.tsx')
    expect(src).toContain('EXISTING_BACKINGS')
    expect(src).toContain('UPSTREAM_CREATE')
    expect(src).toContain('Build from Existing Provider Packages')
    expect(src).toContain('Create New Provider Package')
  })

  it('Mode B requires an explicit upstream confirmation checkbox', () => {
    const src = read('src/app/admin/provider-catalog/custom/new/CustomPackageForm.tsx')
    expect(src).toContain('upstreamConfirmed')
    expect(src).toContain('I understand this creates a package with the provider.')
    expect(src).toContain('This action will create a new package/template with the selected provider')
  })

  it('Mode B form does not send provider credentials/secrets as providerValues', () => {
    const src = read('src/app/admin/provider-catalog/custom/new/CustomPackageForm.tsx')
    // The form only serialises explicit provider fields + sku; no apiToken/password
    // inputs are rendered for upstream creation.
    expect(src).not.toMatch(/name="apiToken"/)
    expect(src).not.toMatch(/name="password"/)
    expect(src).not.toMatch(/name="api_token"/)
    expect(src).not.toMatch(/name="secret"/)
  })
})
