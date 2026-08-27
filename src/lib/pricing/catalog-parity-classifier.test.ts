import { describe, it, expect } from 'vitest'
import { classifyPackage, type ClassifierInput } from './catalog-parity-classifier'

function base(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    retailPackageId: 'retail-1',
    retailDisplayName: 'Test Package',
    retailPriceUSD: 5,
    retailLocalPrice: 5,
    retailCurrency: 'USD',
    providerPackageId: 'pp-1',
    providerPackageSellingPrice: 17,
    providerPackageSellingCurrency: 'USD',
    providerPackageCostStatus: 'VALID',
    providerPackagePricingStatus: 'READY',
    providerPackagePublishStatus: 'PUBLISHED',
    providerPackageConfigurationStatus: 'CONFIGURED',
    providerPackageActivePriceSnapshotId: 'snap-1',
    linkedRetailCount: 1,
    snapshotFinalSellingPrice: 17,
    snapshotStatus: 'ACTIVE',
    ...overrides,
  }
}

describe('classifyPackage', () => {
  it('1. RETAIL_STALE: retail=5, pp=17, snapshot=17 + valid statuses → repairable', () => {
    const result = classifyPackage(base())
    expect(result.classification).toBe('RETAIL_STALE')
    expect(result.repairable).toBe(true)
    expect(result.retailPriceUSD).toBe(5)
    expect(result.providerSellingPrice).toBe(17)
    expect(result.snapshotFinalSellingPrice).toBe(17)
  })

  it('2. PROVIDER_SNAPSHOT_MISMATCH: pp=17, snapshot=18 → never repaired', () => {
    const result = classifyPackage(base({
      providerPackageSellingPrice: 17,
      snapshotFinalSellingPrice: 18,
      retailPriceUSD: 5,
      retailLocalPrice: 5,
    }))
    expect(result.classification).toBe('PROVIDER_SNAPSHOT_MISMATCH')
    expect(result.repairable).toBe(false)
  })

  it('3. NO_SNAPSHOT: no snapshot → never repaired', () => {
    const result = classifyPackage(base({
      providerPackageActivePriceSnapshotId: null,
      snapshotFinalSellingPrice: null,
      snapshotStatus: null,
    }))
    expect(result.classification).toBe('NO_SNAPSHOT')
    expect(result.repairable).toBe(false)
  })

  it('3b. NO_SNAPSHOT: snapshot ID present but record missing → never repaired', () => {
    const result = classifyPackage(base({
      snapshotFinalSellingPrice: null,
      snapshotStatus: null,
    }))
    expect(result.classification).toBe('NO_SNAPSHOT')
    expect(result.repairable).toBe(false)
  })

  it('3c. NO_SNAPSHOT: snapshot status SUPERSeded → never repaired', () => {
    const result = classifyPackage(base({
      snapshotStatus: 'SUPERSEDED',
    }))
    expect(result.classification).toBe('NO_SNAPSHOT')
    expect(result.repairable).toBe(false)
  })

  it('4. NOT_READY: pricing not READY → never repaired', () => {
    const result = classifyPackage(base({
      providerPackagePricingStatus: 'COST_UNAVAILABLE',
    }))
    expect(result.classification).toBe('NOT_READY')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('pricingStatus')
  })

  it('5. NOT_READY: cost not VALID → never repaired', () => {
    const result = classifyPackage(base({
      providerPackageCostStatus: 'MISSING',
    }))
    expect(result.classification).toBe('NOT_READY')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('costStatus')
  })

  it('6. NOT_READY: not PUBLISHED → never repaired', () => {
    const result = classifyPackage(base({
      providerPackagePublishStatus: 'READY',
    }))
    expect(result.classification).toBe('NOT_READY')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('publishStatus')
  })

  it('6b. NOT_READY: configurationStatus UNCONFIGURED → never repaired', () => {
    const result = classifyPackage(base({
      providerPackageConfigurationStatus: 'UNCONFIGURED',
    }))
    expect(result.classification).toBe('NOT_READY')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('configurationStatus')
  })

  it('7. AMBIGUOUS: multiple retail packages linked → never repaired', () => {
    const result = classifyPackage(base({
      linkedRetailCount: 2,
    }))
    expect(result.classification).toBe('AMBIGUOUS')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('2 retail packages')
  })

  it('OK: all prices consistent → not repairable (already correct)', () => {
    const result = classifyPackage(base({
      retailPriceUSD: 17,
      retailLocalPrice: 17,
    }))
    expect(result.classification).toBe('OK')
    expect(result.repairable).toBe(false)
  })

  it('OK: sub-cent tolerance — 0.004 difference is OK', () => {
    const result = classifyPackage(base({
      retailPriceUSD: 17.004,
      retailLocalPrice: 17.004,
      providerPackageSellingPrice: 17.00,
      snapshotFinalSellingPrice: 17.00,
    }))
    expect(result.classification).toBe('OK')
    expect(result.repairable).toBe(false)
  })

  it('OTHER: no providerPackageId → never repaired', () => {
    const result = classifyPackage(base({
      providerPackageId: null,
    }))
    expect(result.classification).toBe('OTHER')
    expect(result.repairable).toBe(false)
  })

  it('OTHER: currency mismatch between retail and PP → never repaired', () => {
    const result = classifyPackage(base({
      retailPriceUSD: 5,
      retailLocalPrice: 5,
      retailCurrency: 'USD',
      providerPackageSellingCurrency: 'EUR',
    }))
    expect(result.classification).toBe('OTHER')
    expect(result.repairable).toBe(false)
    expect(result.reason).toContain('Currency')
  })

  it('RETAIL_STALE is the only repairable classification', () => {
    const classifications = [
      base({ providerPackageActivePriceSnapshotId: null, snapshotFinalSellingPrice: null, snapshotStatus: null }),
      base({ providerPackagePricingStatus: 'COST_UNAVAILABLE' }),
      base({ providerPackageCostStatus: 'MISSING' }),
      base({ providerPackagePublishStatus: 'READY' }),
      base({ providerPackageConfigurationStatus: 'UNCONFIGURED' }),
      base({ providerPackageSellingPrice: 17, snapshotFinalSellingPrice: 18, retailPriceUSD: 5, retailLocalPrice: 5 }),
      base({ linkedRetailCount: 2 }),
      base({ providerPackageId: null }),
      base({ retailPriceUSD: 17, retailLocalPrice: 17 }),
    ]
    for (const input of classifications) {
      const result = classifyPackage(input)
      if (result.classification !== 'RETAIL_STALE') {
        expect(result.repairable).toBe(false)
      }
    }
  })
})
