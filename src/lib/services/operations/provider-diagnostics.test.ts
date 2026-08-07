import { describe, it, expect } from 'vitest'
import { classifyFailureMessage, computePurchaseVerdict, RECOMMENDED_ACTIONS } from './provider-diagnostics'

describe('classifyFailureMessage', () => {
  it('classifies auth failures', () => expect(classifyFailureMessage('Unauthorized access')).toBe('AUTH'))
  it('classifies balance failures', () => expect(classifyFailureMessage('Balance is NA')).toBe('BALANCE'))
  it('classifies validation failures', () => expect(classifyFailureMessage('TravelDate field is required')).toBe('VALIDATION'))
  it('classifies bundle mapping failures', () => expect(classifyFailureMessage('Bundle code not found')).toBe('BUNDLE_MAPPING'))
  it('classifies inventory failures', () => expect(classifyFailureMessage('No SIM inventory available')).toBe('INVENTORY'))
  it('classifies rate limit failures', () => expect(classifyFailureMessage('Rate limit exceeded')).toBe('RATE_LIMIT'))
  it('classifies network failures', () => expect(classifyFailureMessage('Connection refused')).toBe('NETWORK'))
  it('classifies timeout failures', () => expect(classifyFailureMessage('Request timed out')).toBe('TIMEOUT'))
  it('classifies reconciliation failures', () => expect(classifyFailureMessage('Reconciliation required')).toBe('RECONCILIATION'))
  it('classifies provider errors', () => expect(classifyFailureMessage('Internal server error')).toBe('PROVIDER_ERROR'))
  it('classifies unknowns', () => expect(classifyFailureMessage('Some random text')).toBe('UNKNOWN'))
  it('handles null', () => expect(classifyFailureMessage(null)).toBe('UNKNOWN'))
})

describe('computePurchaseVerdict', () => {
  const base = { operational: true, hasPurchase: true, circuitOpen: false, authConfigured: true, readyPackages: 2, recentFailures: 0, hasBalanceError: false, hasBundleError: false }

  it('all clear → READY', () => {
    const v = computePurchaseVerdict(base)
    expect(v.verdict).toBe('READY')
  })

  it('no PURCHASE → BLOCKED', () => {
    const v = computePurchaseVerdict({ ...base, hasPurchase: false })
    expect(v.verdict).toBe('BLOCKED')
  })

  it('not operational → BLOCKED', () => {
    const v = computePurchaseVerdict({ ...base, operational: false })
    expect(v.verdict).toBe('BLOCKED')
  })

  it('circuit open → BLOCKED', () => {
    const v = computePurchaseVerdict({ ...base, circuitOpen: true })
    expect(v.verdict).toBe('BLOCKED')
  })

  it('no ready packages → BLOCKED', () => {
    const v = computePurchaseVerdict({ ...base, readyPackages: 0 })
    expect(v.verdict).toBe('BLOCKED')
  })

  it('balance error → DEGRADED', () => {
    const v = computePurchaseVerdict({ ...base, hasBalanceError: true })
    expect(v.verdict).toBe('DEGRADED')
  })

  it('bundle error → DEGRADED', () => {
    const v = computePurchaseVerdict({ ...base, hasBundleError: true })
    expect(v.verdict).toBe('DEGRADED')
  })

  it('recent failures → DEGRADED', () => {
    const v = computePurchaseVerdict({ ...base, recentFailures: 3 })
    expect(v.verdict).toBe('DEGRADED')
  })

  it('both balance and bundle → DEGRADED', () => {
    const v = computePurchaseVerdict({ ...base, hasBalanceError: true, hasBundleError: true })
    expect(v.verdict).toBe('DEGRADED')
    expect(v.reason).toContain('balance')
    expect(v.reason).toContain('bundle')
  })
})

describe('RECOMMENDED_ACTIONS', () => {
  it('has action for every common alert code', () => {
    const codes = ['PROVIDER_BALANCE_UNAVAILABLE', 'PROVIDER_BALANCE_REJECTED', 'BUNDLE_CODE_NOT_FOUND', 'CIRCUIT_OPEN', 'NO_PURCHASE_READY_PACKAGES', 'AUTH_FAILURE']
    for (const code of codes) expect(RECOMMENDED_ACTIONS[code]).toBeDefined()
  })

  it('balance unavailable and balance rejected are distinct', () => {
    expect(RECOMMENDED_ACTIONS.PROVIDER_BALANCE_UNAVAILABLE).not.toBe(RECOMMENDED_ACTIONS.PROVIDER_BALANCE_REJECTED)
  })

  it('no sensitive fields in actions', () => {
    for (const action of Object.values(RECOMMENDED_ACTIONS)) {
      expect(action).not.toContain('password')
      expect(action).not.toContain('token')
      expect(action).not.toContain('secret')
    }
  })
})
