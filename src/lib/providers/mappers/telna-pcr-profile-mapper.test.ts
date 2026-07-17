import { describe, it, expect } from 'vitest'
import { mapTelnaPCRProfile } from './telna-pcr-profile-mapper'
import type { TelnaPCRProfile } from '../connectors/telna-endpoints'

const baseProfile: TelnaPCRProfile = {
  id: 1,
  iccid: '89012345678901234567',
  status: 'ACTIVE',
  current_package: { id: 5001, package_template_id: 1001, name: '5GB Monthly Data' },
  pending_package: undefined,
  traffic_policy_id: 50,
  wallet_id: 200,
  activation_state: 'ACTIVATED',
  renewal: { enabled: true, renewal_date: '2026-01-15T00:00:00Z', renewal_package_id: 5001 },
  expiration: { expired: false, expiration_date: '2025-08-15T00:00:00Z' },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-07-01T00:00:00Z',
}

describe('mapTelnaPCRProfile', () => {
  it('maps a complete PCR profile', () => {
    const result = mapTelnaPCRProfile(baseProfile)
    expect(result.iccid).toBe('89012345678901234567')
    expect(result.status).toBe('ACTIVE')
    expect(result.currentPackage.id).toBe('5001')
    expect(result.currentPackage.packageTemplateId).toBe('1001')
    expect(result.currentPackage.name).toBe('5GB Monthly Data')
    expect(result.pendingPackage.id).toBeNull()
    expect(result.pendingPackage.name).toBeNull()
    expect(result.trafficPolicyId).toBe(50)
    expect(result.walletId).toBe(200)
    expect(result.activationState).toBe('ACTIVATED')
    expect(result.renewal.enabled).toBe(true)
    expect(result.renewal.renewalDate).toBe('2026-01-15T00:00:00Z')
    expect(result.renewal.renewalPackageId).toBe('5001')
    expect(result.expiration.expired).toBe(false)
    expect(result.expiration.expirationDate).toBe('2025-08-15T00:00:00Z')
    expect(result.createdAt).toBe('2025-01-01T00:00:00Z')
    expect(result.updatedAt).toBe('2025-07-01T00:00:00Z')
  })

  it('maps pending package when present', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      pending_package: { id: 6002, package_template_id: 2002, name: '10GB Global Data' },
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.pendingPackage.id).toBe('6002')
    expect(result.pendingPackage.packageTemplateId).toBe('2002')
    expect(result.pendingPackage.name).toBe('10GB Global Data')
  })

  it('handles null current_package fields', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      current_package: { id: null as any, package_template_id: null as any, name: undefined },
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.currentPackage.id).toBeNull()
    expect(result.currentPackage.packageTemplateId).toBeNull()
    expect(result.currentPackage.name).toBeNull()
  })

  it('handles missing renewal', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      renewal: undefined,
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.renewal.enabled).toBe(false)
    expect(result.renewal.renewalDate).toBeNull()
    expect(result.renewal.renewalPackageId).toBeNull()
  })

  it('handles missing expiration', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      expiration: undefined,
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.expiration.expired).toBe(false)
    expect(result.expiration.expirationDate).toBeNull()
  })

  it('handles missing optional scalars', () => {
    const profile: TelnaPCRProfile = {
      id: 2, iccid: '89098765432109876543', status: 'SUSPENDED',
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.iccid).toBe('89098765432109876543')
    expect(result.status).toBe('SUSPENDED')
    expect(result.currentPackage.id).toBeNull()
    expect(result.trafficPolicyId).toBeNull()
    expect(result.walletId).toBeNull()
    expect(result.activationState).toBeNull()
    expect(result.createdAt).toBeNull()
    expect(result.updatedAt).toBeNull()
  })

  it('handles expired SIM', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      expiration: { expired: true, expiration_date: '2025-06-01T00:00:00Z' },
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.expiration.expired).toBe(true)
    expect(result.expiration.expirationDate).toBe('2025-06-01T00:00:00Z')
  })

  it('preserves unknown fields in rawData', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      custom_field: 'test',
      nested: { key: 'value' },
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.rawData.custom_field).toBe('test')
    expect(result.rawData.nested).toEqual({ key: 'value' })
  })

  it('handles string IDs', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      current_package: { id: 'PKG-5001', package_template_id: 'TPL-1001', name: 'Custom Package' },
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.currentPackage.id).toBe('PKG-5001')
    expect(result.currentPackage.packageTemplateId).toBe('TPL-1001')
  })

  it('handles unknown status', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      status: 'UNKNOWN_STATUS',
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.status).toBe('UNKNOWN_STATUS')
  })
})
