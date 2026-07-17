import { describe, it, expect } from 'vitest'
import { mapTelnaSimRegistry, normalizeSimStatus, computeSimComparableKey } from './telna-sim-mapper'
import type { TelnaSimRegistry } from '../connectors/telna-endpoints'

const baseSim: TelnaSimRegistry = {
  id: 1,
  iccid: '89012345678901234567',
  imsi: '310150123456789',
  msisdn: '+12025551234',
  status: 'AVAILABLE',
  inventory_id: 10,
  group_id: 20,
  wallet_id: 30,
  current_package_id: 5001,
  package_template_id: 1001,
  traffic_policy_id: 50,
  pcr_profile_id: 60,
  activation_date: '2025-01-15T00:00:00Z',
  last_session: '2025-06-01T12:00:00Z',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
}

describe('normalizeSimStatus', () => {
  it('maps AVAILABLE to NOT_SENT', () => {
    expect(normalizeSimStatus('AVAILABLE')).toBe('NOT_SENT')
  })

  it('maps ALLOCATED to PENDING', () => {
    expect(normalizeSimStatus('ALLOCATED')).toBe('PENDING')
  })

  it('maps ACTIVE to ACTIVE', () => {
    expect(normalizeSimStatus('ACTIVE')).toBe('ACTIVE')
  })

  it('maps SUSPENDED to SUSPENDED', () => {
    expect(normalizeSimStatus('SUSPENDED')).toBe('SUSPENDED')
  })

  it('maps INACTIVE to INACTIVE', () => {
    expect(normalizeSimStatus('INACTIVE')).toBe('INACTIVE')
  })

  it('maps RETIRED to RETIRED', () => {
    expect(normalizeSimStatus('RETIRED')).toBe('RETIRED')
  })

  it('maps unknown status to UNKNOWN', () => {
    expect(normalizeSimStatus('UNKNOWN_STATUS')).toBe('UNKNOWN')
  })

  it('maps empty string to UNKNOWN', () => {
    expect(normalizeSimStatus('')).toBe('UNKNOWN')
  })
})

describe('mapTelnaSimRegistry', () => {
  it('maps a complete SIM registry entry', () => {
    const result = mapTelnaSimRegistry(baseSim)
    expect(result.iccid).toBe('89012345678901234567')
    expect(result.imsi).toBe('310150123456789')
    expect(result.msisdn).toBe('+12025551234')
    expect(result.inventoryId).toBe(10)
    expect(result.groupId).toBe(20)
    expect(result.walletId).toBe(30)
    expect(result.currentPackageId).toBe('5001')
    expect(result.packageTemplateId).toBe('1001')
    expect(result.trafficPolicyId).toBe(50)
    expect(result.profileId).toBe(60)
    expect(result.activationDate).toBe('2025-01-15T00:00:00Z')
    expect(result.lastSession).toBe('2025-06-01T12:00:00Z')
    expect(result.providerStatus).toBe('AVAILABLE')
    expect(result.status).toBe('NOT_SENT')
    expect(result.normalizedStatus).toBe('NOT_SENT')
    expect(result.createdAt).toBe('2025-01-01T00:00:00Z')
    expect(result.updatedAt).toBe('2025-06-01T00:00:00Z')
  })

  it('normalizes ACTIVE status', () => {
    const sim = { ...baseSim, status: 'ACTIVE' as const }
    const result = mapTelnaSimRegistry(sim)
    expect(result.normalizedStatus).toBe('ACTIVE')
  })

  it('normalizes ALLOCATED status to PENDING', () => {
    const sim = { ...baseSim, status: 'ALLOCATED' as const }
    const result = mapTelnaSimRegistry(sim)
    expect(result.normalizedStatus).toBe('PENDING')
  })

  it('normalizes SUSPENDED status', () => {
    const sim = { ...baseSim, status: 'SUSPENDED' as const }
    const result = mapTelnaSimRegistry(sim)
    expect(result.normalizedStatus).toBe('SUSPENDED')
  })

  it('handles missing optional fields', () => {
    const sim: TelnaSimRegistry = { id: 2, iccid: '89098765432109876543', status: 'AVAILABLE' }
    const result = mapTelnaSimRegistry(sim)
    expect(result.iccid).toBe('89098765432109876543')
    expect(result.imsi).toBeNull()
    expect(result.msisdn).toBeNull()
    expect(result.inventoryId).toBeNull()
    expect(result.groupId).toBeNull()
    expect(result.walletId).toBeNull()
    expect(result.currentPackageId).toBeNull()
    expect(result.packageTemplateId).toBeNull()
    expect(result.trafficPolicyId).toBeNull()
    expect(result.profileId).toBeNull()
    expect(result.activationDate).toBeNull()
    expect(result.lastSession).toBeNull()
  })

  it('handles unknown status', () => {
    const sim = { ...baseSim, status: 'CUSTOM_STATUS' }
    const result = mapTelnaSimRegistry(sim)
    expect(result.normalizedStatus).toBe('UNKNOWN')
    expect(result.providerStatus).toBe('CUSTOM_STATUS')
  })

  it('preserves rawData with all original fields', () => {
    const sim = { ...baseSim, custom_field: 'test_value' }
    const result = mapTelnaSimRegistry(sim)
    expect(result.rawData.iccid).toBe('89012345678901234567')
    expect(result.rawData.custom_field).toBe('test_value')
    expect(result.rawData.status).toBe('AVAILABLE')
  })

  it('handles missing IMSI value of empty string', () => {
    const sim = { ...baseSim, imsi: '' }
    const result = mapTelnaSimRegistry(sim)
    expect(result.imsi).toBeNull()
  })

  it('handles numeric current_package_id', () => {
    const sim = { ...baseSim, current_package_id: 5001 }
    const result = mapTelnaSimRegistry(sim)
    expect(result.currentPackageId).toBe('5001')
  })

  it('handles null current_package_id', () => {
    const sim = { ...baseSim, current_package_id: null as any }
    const result = mapTelnaSimRegistry(sim)
    expect(result.currentPackageId).toBeNull()
  })
})

describe('computeSimComparableKey', () => {
  it('produces key with iccid prefix', () => {
    const key = computeSimComparableKey('89012345678901234567')
    expect(key).toBe('sim:iccid:89012345678901234567')
  })
})
