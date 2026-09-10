import { describe, it, expect } from 'vitest'
import { mapTelnaPCRProfile } from './telna-pcr-profile-mapper'
import type { TelnaPCRProfile } from '../connectors/telna-endpoints'

const baseProfile: TelnaPCRProfile = {
  sim: '89012345678901234567',
  data: { state: 'IN_SERVICE', active_throttling: '1' },
  voice: { state: 'ACTIVE' },
  sms: { state: 'ACTIVE' },
  wallet_mode: 'GROUP',
  wallets: [
    {
      id: 200,
      wallet_type: 'PRIMARY',
      owner: { group: 10 },
      balance: 12.5,
      overdraft: 0,
    },
  ],
  route_policy: { id: 50, name: 'Standard' },
}

describe('mapTelnaPCRProfile', () => {
  it('maps a complete V2.1 PCR profile (sim identity + signal/wallet/route state)', () => {
    const result = mapTelnaPCRProfile(baseProfile)
    expect(result.sim).toBe('89012345678901234567')
    expect(result.dataState).toBe('IN_SERVICE')
    expect(result.activeThrottling).toBe('1')
    expect(result.voiceState).toBe('ACTIVE')
    expect(result.smsState).toBe('ACTIVE')
    expect(result.walletMode).toBe('GROUP')
    expect(result.wallets).toHaveLength(1)
    expect(result.wallets[0].id).toBe('200')
    expect(result.wallets[0].walletType).toBe('PRIMARY')
    expect(result.wallets[0].ownerGroup).toBe('10')
    expect(result.wallets[0].ownerInventory).toBeNull()
    expect(result.wallets[0].ownerSim).toBeNull()
    expect(result.wallets[0].balance).toBe(12.5)
    expect(result.wallets[0].overdraft).toBe(0)
    expect(result.routePolicyId).toBe('50')
  })

  it('normalizes numeric and string wallet owner ids', () => {
    const profile: TelnaPCRProfile = {
      ...baseProfile,
      sim: 'SIM-ABC',
      wallet_mode: 'SIM',
      wallets: [
        { id: 'w-1', wallet_type: 'SIM', owner: { inventory: 'inv-9', sim: 'SIM-ABC', group: 7 }, balance: 0, overdraft: 5 },
      ],
    }
    const result = mapTelnaPCRProfile(profile)
    expect(result.walletMode).toBe('SIM')
    expect(result.wallets[0].ownerInventory).toBe('inv-9')
    expect(result.wallets[0].ownerGroup).toBe('7')
    expect(result.wallets[0].ownerSim).toBe('SIM-ABC')
    expect(result.wallets[0].balance).toBe(0)
    expect(result.wallets[0].overdraft).toBe(5)
  })

  it('route_policy may be a plain scalary value (string or number)', () => {
    expect(mapTelnaPCRProfile({ ...baseProfile, route_policy: 'APP-DEFAULT' }).routePolicyId).toBe('APP-DEFAULT')
    expect(mapTelnaPCRProfile({ ...baseProfile, route_policy: 7 }).routePolicyId).toBe('7')
    expect(mapTelnaPCRProfile({ ...baseProfile, route_policy: null }).routePolicyId).toBeNull()
  })

  it('handles missing nested sections and missing wallets', () => {
    const result = mapTelnaPCRProfile({ sim: '89012345678901234567' })
    expect(result.dataState).toBeNull()
    expect(result.activeThrottling).toBeNull()
    expect(result.voiceState).toBeNull()
    expect(result.smsState).toBeNull()
    expect(result.walletMode).toBeNull()
    expect(result.wallets).toEqual([])
    expect(result.routePolicyId).toBeNull()
    expect(result.sim).toBe('89012345678901234567')
  })

  it('emits an empty sim when the provider response lacks a SIM identity', () => {
    const result = mapTelnaPCRProfile({} as TelnaPCRProfile)
    expect(result.sim).toBe('')
    expect(result.wallets).toEqual([])
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

  it('NEVER exposes a package-instance reference (no currentPackage/pendingPackage/status/expiration)', () => {
    const result = mapTelnaPCRProfile(baseProfile) as Record<string, unknown>
    expect('currentPackage' in result).toBe(false)
    expect('pendingPackage' in result).toBe(false)
    expect('status' in result).toBe(false)
    expect('expiration' in result).toBe(false)
    expect('iccid' in result).toBe(false)
  })

  it('ignores a legacy package-shaped field that may arrive (defensive — never mapped)', () => {
    const profile = { ...baseProfile, current_package: { id: 5001 }, status: 'ACTIVE' } as unknown as TelnaPCRProfile
    const result = mapTelnaPCRProfile(profile) as Record<string, unknown>
    expect('currentPackage' in result).toBe(false)
    expect(result.routePolicyId).toBe('50')
  })
})