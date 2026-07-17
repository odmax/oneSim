import { describe, it, expect } from 'vitest'
import { mapTelnaPackage, computePackageComparableKey } from './telna-package-mapper'
import type { TelnaPackage } from '../connectors/telna-endpoints'

const basePackage: TelnaPackage = {
  id: 5001,
  package_template_id: 1001,
  inventory_id: 10,
  name: '5GB Monthly Data Package',
  status: 'ACTIVE',
  data_allowance: { value: 5, unit: 'GB' },
  time_allowance: { value: 1, unit: 'MONTH' },
  price: 25.00,
  currency: 'USD',
  countries: [{ name: 'United States', iso: 'US', code: '1' }],
  traffic_policy_id: 50,
  route_policy_id: 60,
  wallet_id: 200,
  activation_mode: 'AUTO',
  coverage_type: 'LOCAL',
  type: 'DATA',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
}

describe('mapTelnaPackage', () => {
  it('maps a complete package with data conversion', () => {
    const result = mapTelnaPackage(basePackage)
    expect(result.providerPackageId).toBe('5001')
    expect(result.providerTemplateId).toBe('1001')
    expect(result.name).toBe('5GB Monthly Data Package')
    expect(result.status).toBe('ACTIVE')
    expect(result.currency).toBe('USD')
    expect(result.costPrice).toBe(25.00)
    expect(result.dataGB).toBe(5)
    expect(result.dataBytes).toBe(5 * 1024 * 1024 * 1024)
    expect(result.validityDays).toBe(30)
    expect(result.country).toBe('United States')
    expect(result.countryCodes).toContain('US')
    expect(result.coverageType).toBe('LOCAL')
    expect(result.planType).toBe('LOCAL')
    expect(result.isAvailable).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('maps isAvailable false when status is not ACTIVE', () => {
    const p = { ...basePackage, status: 'INACTIVE' }
    const result = mapTelnaPackage(p)
    expect(result.isAvailable).toBe(false)
    expect(result.status).toBe('INACTIVE')
  })

  it('handles DAY time allowance', () => {
    const p = { ...basePackage, time_allowance: { value: 7, unit: 'DAY' as const } }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBe(7)
  })

  it('handles WEEK time allowance', () => {
    const p = { ...basePackage, time_allowance: { value: 2, unit: 'WEEK' as const } }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBe(14)
  })

  it('handles CALENDAR_MONTH with warning', () => {
    const p = { ...basePackage, time_allowance: { value: 1, unit: 'CALENDAR_MONTH' as const } }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBeNull()
    expect(result.warnings).toContain('Cannot safely convert time allowance unit "CALENDAR_MONTH" to days; original value=1')
  })

  it('handles HOUR without day conversion', () => {
    const p = { ...basePackage, time_allowance: { value: 24, unit: 'HOUR' as const } }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBeNull()
  })

  it('handles unlimited data', () => {
    const p = { ...basePackage, data_allowance: { value: 0, unit: 'UNLIMITED' as const } }
    const result = mapTelnaPackage(p)
    expect(result.dataGB).toBeNull()
    expect(result.dataBytes).toBeNull()
  })

  it('handles MB data allowance', () => {
    const p = { ...basePackage, data_allowance: { value: 512, unit: 'MB' as const } }
    const result = mapTelnaPackage(p)
    expect(result.dataGB).toBe(0.5)
    expect(result.dataBytes).toBe(512 * 1024 * 1024)
  })

  it('handles TB data allowance', () => {
    const p = { ...basePackage, data_allowance: { value: 1, unit: 'TB' as const } }
    const result = mapTelnaPackage(p)
    expect(result.dataGB).toBe(1024)
    expect(result.dataBytes).toBe(1024 * 1024 * 1024 * 1024)
  })

  it('handles KB data allowance', () => {
    const p = { ...basePackage, data_allowance: { value: 500, unit: 'KB' as const } }
    const result = mapTelnaPackage(p)
    expect(result.dataBytes).toBe(500 * 1024)
    expect(result.dataGB).toBe(0)
  })

  it('warns on unknown data unit', () => {
    const p = { ...basePackage, data_allowance: { value: 100, unit: 'PETA' as const } }
    const result = mapTelnaPackage(p)
    expect(result.dataGB).toBeNull()
    expect(result.warnings).toContain('Unknown data allowance unit "PETA"; value=100')
  })

  it('warns on unknown time unit', () => {
    const p = { ...basePackage, time_allowance: { value: 5, unit: 'BILLING_CYCLE' as const } }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBeNull()
    expect(result.warnings).toContain('Unknown time allowance unit "BILLING_CYCLE"; cannot normalize')
  })

  it('handles missing data allowance', () => {
    const p = { ...basePackage, data_allowance: undefined }
    const result = mapTelnaPackage(p)
    expect(result.dataGB).toBeNull()
    expect(result.dataBytes).toBeNull()
  })

  it('handles missing time allowance', () => {
    const p = { ...basePackage, time_allowance: undefined }
    const result = mapTelnaPackage(p)
    expect(result.validityDays).toBeNull()
  })

  it('handles null id', () => {
    const p = { ...basePackage, id: null as any }
    const result = mapTelnaPackage(p)
    expect(result.providerPackageId).toBe('')
    expect(result.warnings).toContain('Package has no id')
  })

  it('handles string id', () => {
    const p = { ...basePackage, id: 'PKG-5001' as any }
    const result = mapTelnaPackage(p)
    expect(result.providerPackageId).toBe('PKG-5001')
  })

  it('extracts cost price from price object', () => {
    const p = { ...basePackage, currency: undefined, price: { amount: 12.50, currency: 'GBP', type: 'FIXED' as const } }
    const result = mapTelnaPackage(p)
    expect(result.costPrice).toBe(12.50)
    expect(result.currency).toBe('GBP')
  })

  it('returns null costPrice when no pricing info', () => {
    const p = { ...basePackage, price: undefined, currency: undefined }
    const result = mapTelnaPackage(p)
    expect(result.costPrice).toBeNull()
    expect(result.currency).toBe('')
  })

  it('maps coverage from zones', () => {
    const p = {
      ...basePackage,
      countries: [],
      zones: [
        {
          name: 'Europe Zone',
          countryCodes: ['DE', 'FR', 'ES'],
          countries: [{ name: 'Germany', iso: 'DE' }],
        },
      ],
    }
    const result = mapTelnaPackage(p)
    expect(result.country).toBe('Germany')
    expect(result.region).toBe('Europe Zone')
    expect(result.countryCodes).toContain('DE')
    expect(result.countryCodes).toContain('FR')
    expect(result.countryCodes).toContain('ES')
  })

  it('warns on no coverage', () => {
    const p = { ...basePackage, countries: [], zones: [] }
    const result = mapTelnaPackage(p)
    expect(result.warnings).toContain('No coverage information found on package')
  })

  it('preserves unknown fields in rawData', () => {
    const p = { ...basePackage, custom_field: 'test_value', nested: { foo: 'bar' } }
    const result = mapTelnaPackage(p)
    expect(result.rawData.custom_field).toBe('test_value')
    expect(result.rawData.nested).toEqual({ foo: 'bar' })
  })

  it('handles missing name', () => {
    const p = { ...basePackage, name: undefined }
    const result = mapTelnaPackage(p)
    expect(result.name).toBe('')
  })

  it('handles null package_template_id', () => {
    const p = { ...basePackage, package_template_id: null as any }
    const result = mapTelnaPackage(p)
    expect(result.providerTemplateId).toBeNull()
  })
})

describe('computePackageComparableKey', () => {
  it('produces local key for local coverage', () => {
    const mapped = mapTelnaPackage(basePackage)
    const key = computePackageComparableKey(mapped)
    expect(key).toMatch(/^local:/)
    expect(key).toContain('UNITED STATES')
    expect(key).toContain('5GB')
    expect(key).toContain('30')
  })

  it('produces global key for global coverage', () => {
    const p = { ...basePackage, coverage_type: 'GLOBAL', countries: [] }
    const mapped = mapTelnaPackage(p)
    const key = computePackageComparableKey(mapped)
    expect(key).toMatch(/^global:/)
  })

  it('produces regional key for regional zones', () => {
    const p = {
      ...basePackage,
      coverage_type: 'REGIONAL',
      zones: [{ name: 'INT' as const, countryCodes: ['DE', 'FR'] }],
    }
    const mapped = mapTelnaPackage(p)
    const key = computePackageComparableKey(mapped)
    expect(key).toMatch(/^regional:/)
  })

  it('handles null dataGB gracefully', () => {
    const p = { ...basePackage, data_allowance: undefined }
    const mapped = mapTelnaPackage(p)
    const key = computePackageComparableKey(mapped)
    expect(key).toBeTruthy()
  })

  it('handles null validityDays gracefully', () => {
    const p = { ...basePackage, time_allowance: undefined }
    const mapped = mapTelnaPackage(p)
    const key = computePackageComparableKey(mapped)
    expect(key).toBeTruthy()
  })
})
