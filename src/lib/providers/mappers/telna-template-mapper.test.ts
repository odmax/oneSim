import { describe, it, expect } from 'vitest'
import { mapTelnaPackageTemplate } from './telna-template-mapper'
import type { TelnaPackageTemplate } from '../connectors/telna-endpoints'

const baseTemplate: TelnaPackageTemplate = {
  id: 1001,
  name: 'Test 5GB Monthly Plan',
  description: 'A monthly 5GB data plan',
  inventory_id: 10,
  status: 'ACTIVE',
  package_type: 'DATA',
  currency: 'USD',
  price: 25.00,
  data_allowance: { value: 5, unit: 'GB' },
  time_allowance: { value: 1, unit: 'MONTH' },
  countries: [{ name: 'United States', iso: 'US', code: '1' }],
  traffic_policy_id: 50,
  route_policy_id: 60,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
}

describe('mapTelnaPackageTemplate', () => {
  it('maps a complete template with data conversion', () => {
    const result = mapTelnaPackageTemplate(baseTemplate)
    expect(result.providerTemplateId).toBe('1001')
    expect(result.name).toBe('Test 5GB Monthly Plan')
    expect(result.inventoryId).toBe(10)
    expect(result.status).toBe('ACTIVE')
    expect(result.currency).toBe('USD')
    expect(result.providerCost).toBe(25.00)
    expect(result.dataAllowance).toEqual({ value: 5, unit: 'GB' })
    expect(result.dataGB).toBe(5)
    expect(result.dataMB).toBe(5120)
    expect(result.dataBytes).toBe(5 * 1024 * 1024 * 1024)
    expect(result.unlimitedData).toBe(false)
    expect(result.timeAllowance).toEqual({ value: 1, unit: 'MONTH' })
    expect(result.validityDays).toBe(30)
    expect(result.countries).toEqual(['United States'])
    expect(result.countryCodes).toEqual(['US', '1'])
    expect(result.trafficPolicyId).toBe('50')
    expect(result.routePolicyId).toBe('60')
    expect(result.warnings).toHaveLength(0)
  })

  it('maps DAY validity correctly', () => {
    const t = { ...baseTemplate, time_allowance: { value: 3, unit: 'DAY' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBe(3)
    expect(result.timeAllowance).toEqual({ value: 3, unit: 'DAY' })
    expect(result.warnings).toHaveLength(0)
  })

  it('maps WEEK validity correctly', () => {
    const t = { ...baseTemplate, time_allowance: { value: 2, unit: 'WEEK' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBe(14)
    expect(result.warnings).toHaveLength(0)
  })

  it('maps MONTH validity as 30 days', () => {
    const t = { ...baseTemplate, time_allowance: { value: 1, unit: 'MONTH' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBe(30)
    expect(result.warnings).toHaveLength(0)
  })

  it('retains CALENDAR_MONTH without unsafe conversion', () => {
    const t = { ...baseTemplate, time_allowance: { value: 1, unit: 'CALENDAR_MONTH' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBeNull()
    expect(result.timeAllowance).toEqual({ value: 1, unit: 'CALENDAR_MONTH' })
    expect(result.warnings).toContain('Cannot safely convert time allowance unit "CALENDAR_MONTH" to days; original value=1')
  })

  it('maps HOUR without day conversion', () => {
    const t = { ...baseTemplate, time_allowance: { value: 24, unit: 'HOUR' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBeNull()
    expect(result.timeAllowance).toEqual({ value: 24, unit: 'HOUR' })
  })

  it('handles unlimited data', () => {
    const t = { ...baseTemplate, data_allowance: { value: 0, unit: 'UNLIMITED' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.unlimitedData).toBe(true)
    expect(result.dataGB).toBeNull()
    expect(result.dataMB).toBeNull()
    expect(result.dataBytes).toBeNull()
    expect(result.warnings).toHaveLength(0)
  })

  it('handles MB data allowance with decimal-safe conversion', () => {
    const t = { ...baseTemplate, data_allowance: { value: 512.5, unit: 'MB' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.dataMB).toBe(512.5)
    expect(result.dataGB).toBe(512.5 / 1024)
    expect(result.dataBytes).toBe(Math.round(512.5 * 1024 * 1024))
  })

  it('handles TB data allowance', () => {
    const t = { ...baseTemplate, data_allowance: { value: 1, unit: 'TB' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.dataGB).toBe(1024)
    expect(result.dataMB).toBe(1024 * 1024)
  })

  it('handles KB data allowance', () => {
    const t = { ...baseTemplate, data_allowance: { value: 500, unit: 'KB' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.dataBytes).toBe(500 * 1024)
    expect(result.dataMB).toBe(500 / 1024)
    expect(result.dataGB).toBe(500 / (1024 * 1024))
  })

  it('warns on unknown data unit', () => {
    const t = { ...baseTemplate, data_allowance: { value: 100, unit: 'PETA' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.dataGB).toBeNull()
    expect(result.warnings).toContain('Unknown data allowance unit "PETA"; value=100')
  })

  it('preserves unknown fields in rawData', () => {
    const t = { ...baseTemplate, custom_field: 'hello', nested: { key: 'val' } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.rawData.custom_field).toBe('hello')
    expect(result.rawData.nested).toEqual({ key: 'val' })
  })

  it('does not throw on malformed optional fields', () => {
    const t = { ...baseTemplate, countries: null, zones: undefined, price: undefined, currency: undefined } as any
    const result = mapTelnaPackageTemplate(t)
    expect(result.countries).toEqual([])
    expect(result.countryCodes).toEqual([])
    expect(result.currency).toBe('')
    expect(result.providerCost).toBeNull()
    expect(result.warnings).toContain('No coverage information found on template')
  })

  it('does not throw on missing id', () => {
    const t = { ...baseTemplate, id: undefined } as any
    const result = mapTelnaPackageTemplate(t)
    expect(result.providerTemplateId).toBe('')
    expect(result.warnings).toContain('Template has no id')
  })

  it('does not throw on null id', () => {
    const t = { ...baseTemplate, id: null } as any
    const result = mapTelnaPackageTemplate(t)
    expect(typeof result.providerTemplateId).toBe('string')
  })

  it('maps coverage from zones', () => {
    const t = {
      ...baseTemplate,
      countries: [],
      zones: [
        {
          name: 'Europe Zone',
          type: 'REGIONAL',
          countryCodes: ['DE', 'FR', 'ES'],
          countries: [{ name: 'Germany', iso: 'DE' }, { name: 'France', iso: 'FR' }],
        },
      ],
    }
    const result = mapTelnaPackageTemplate(t)
    expect(result.regions).toContain('Europe Zone')
    expect(result.regions).toContain('REGIONAL')
    expect(result.countryCodes).toContain('DE')
    expect(result.countryCodes).toContain('FR')
    expect(result.countryCodes).toContain('ES')
    expect(result.countries).toContain('Germany')
    expect(result.countries).toContain('France')
  })

  it('warns on unresolved coverage', () => {
    const t = { ...baseTemplate, countries: [], zones: [] }
    const result = mapTelnaPackageTemplate(t)
    expect(result.warnings).toContain('No coverage information found on template')
  })

  it('warns when countries field is not an array', () => {
    const t = { ...baseTemplate, countries: 'invalid' as any }
    const result = mapTelnaPackageTemplate(t)
    expect(result.warnings).toContain('countries field present but not an array')
  })

  it('extracts provider cost from charging object when price is not a number', () => {
    const t = {
      ...baseTemplate,
      price: undefined,
      currency: undefined,
      charging: { type: 'FIXED', amount: 19.99, currency: 'EUR' },
    }
    const result = mapTelnaPackageTemplate(t)
    expect(result.providerCost).toBe(19.99)
    expect(result.currency).toBe('EUR')
  })

  it('extracts price object amount', () => {
    const t = {
      ...baseTemplate,
      currency: undefined,
      price: { amount: 12.50, currency: 'GBP', type: 'FIXED' },
    }
    const result = mapTelnaPackageTemplate(t)
    expect(result.providerCost).toBe(12.50)
    expect(result.currency).toBe('GBP')
  })

  it('returns null providerCost when no pricing info available', () => {
    const t = { ...baseTemplate, price: undefined, charging: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.providerCost).toBeNull()
  })

  it('handles empty time allowance', () => {
    const t = { ...baseTemplate, time_allowance: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBeNull()
    expect(result.timeAllowance).toBeNull()
    expect(result.warnings).toHaveLength(0)
  })

  it('handles unknown time allowance unit', () => {
    const t = { ...baseTemplate, time_allowance: { value: 5, unit: 'BILLING_CYCLE' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.validityDays).toBeNull()
    expect(result.warnings).toContain('Unknown time allowance unit "BILLING_CYCLE"; cannot normalize')
  })

  it('handles missing data allowance', () => {
    const t = { ...baseTemplate, data_allowance: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.dataGB).toBeNull()
    expect(result.dataMB).toBeNull()
    expect(result.dataBytes).toBeNull()
    expect(result.unlimitedData).toBe(false)
  })

  it('maps description as null when not provided', () => {
    const t = { ...baseTemplate, description: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.description).toBeNull()
  })

  it('preserves inventory_id as null when not provided', () => {
    const t = { ...baseTemplate, inventory_id: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.inventoryId).toBeNull()
  })

  it('maps status as UNKNOWN when not provided', () => {
    const t = { ...baseTemplate, status: undefined }
    const result = mapTelnaPackageTemplate(t)
    expect(result.status).toBe('UNKNOWN')
  })

  it('recurring settings are preserved in rawData', () => {
    const t = { ...baseTemplate, recurring: { enabled: true, period: { value: 1, unit: 'MONTH' }, renewal_price: 20 } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.rawData.recurring).toEqual({ enabled: true, period: { value: 1, unit: 'MONTH' }, renewal_price: 20 })
  })

  it('handles string IDs correctly', () => {
    const t = { ...baseTemplate, id: 'TMPL-2001' as any }
    const result = mapTelnaPackageTemplate(t)
    expect(result.providerTemplateId).toBe('TMPL-2001')
  })

  it('returns warnings count matching warning array length', () => {
    const t = { ...baseTemplate, countries: null as any, data_allowance: { value: 100, unit: 'UNKNOWN' as const }, time_allowance: { value: 1, unit: 'CALENDAR_MONTH' as const } }
    const result = mapTelnaPackageTemplate(t)
    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
    expect(result.warnings.every(w => typeof w === 'string')).toBe(true)
  })
})
