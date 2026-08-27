import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serializePublicPackage, findForbiddenFields } from '@/lib/api/public-dto'

const ROOT = process.cwd()

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
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
