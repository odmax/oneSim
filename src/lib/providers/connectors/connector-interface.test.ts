import { describe, it, expect } from 'vitest'
import { defaultAuthActionLabel, DEFAULT_CONNECTOR_CAPABILITIES } from './connector-interface'

describe('provider-neutral auth model', () => {
  it('derives the correct admin action label per auth mode', () => {
    expect(defaultAuthActionLabel('STATIC_KEY_ID')).toBe('Save & Verify')
    expect(defaultAuthActionLabel('STATIC_API_KEY')).toBe('Save & Verify')
    expect(defaultAuthActionLabel('BEARER_TOKEN')).toBe('Save & Verify')
    expect(defaultAuthActionLabel('LOGIN_TOKEN')).toBe('Save & Authenticate')
    expect(defaultAuthActionLabel('OAUTH')).toBe('Connect')
    expect(defaultAuthActionLabel('NONE')).toBe('Verify Connection')
    expect(defaultAuthActionLabel('CUSTOM')).toBe('Save & Authenticate')
  })

  it('default capabilities are all false (connector must declare truth)', () => {
    expect(DEFAULT_CONNECTOR_CAPABILITIES.installationLookup).toBe(false)
    expect(DEFAULT_CONNECTOR_CAPABILITIES.installationDataAtPurchase).toBe(false)
    expect(DEFAULT_CONNECTOR_CAPABILITIES.installationLookupHistorical).toBe(false)
    expect(DEFAULT_CONNECTOR_CAPABILITIES.statusLookup).toBe(false)
  })
})
