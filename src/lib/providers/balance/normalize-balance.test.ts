import { describe, it, expect } from 'vitest'
import { normalizeBalanceResponse, probeBalanceFields, DEFAULT_BALANCE_KEYS } from './normalize-balance'

const LIVE_CHOICE = {
  account_id: '217',
  current_prepaid_balance: 972.6487339312149,
}

describe('normalizeBalanceResponse — current_prepaid_balance', () => {
  it('maps the live Choice response to a normalized balance', () => {
    const r = normalizeBalanceResponse(LIVE_CHOICE)
    expect(r.success).toBe(true)
    expect(r.balance).toBe(972.6487339312149)
    expect(r.currency).toBe('USD')
    expect(r.balancePath).toBe('current_prepaid_balance')
  })

  it('maps a direct numeric current_prepaid_balance', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: 25.5 })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(25.5)
  })

  it('maps a current_prepaid_balance numeric string', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: '125.50' })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(125.5)
  })

  it('maps camelCase currentPrepaidBalance', () => {
    const r = normalizeBalanceResponse({ currentPrepaidBalance: 42 })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(42)
    expect(r.balancePath).toBe('currentPrepaidBalance')
  })

  it('treats zero current_prepaid_balance as valid', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: 0 })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(0)
  })

  it('rejects a malformed current_prepaid_balance', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: 'abc' })
    expect(r.success).toBe(false)
    expect(r.reason).toContain('No numeric balance field')
  })

  it('uses the configured currency when none is returned', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: 5 }, { fallbackCurrency: 'GBP' })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(5)
    expect(r.currency).toBe('GBP')
  })

  it('falls back to USD when no currency is returned', () => {
    const r = normalizeBalanceResponse({ current_prepaid_balance: '5.00' })
    expect(r.success).toBe(true)
    expect(r.currency).toBe('USD')
  })

  it('does not mistake account_id for a balance', () => {
    const r = normalizeBalanceResponse({ account_id: '217' })
    expect(r.success).toBe(false)
  })

  it('keeps existing aliases unchanged', () => {
    expect(normalizeBalanceResponse({ balance: 10 }).balance).toBe(10)
    expect(normalizeBalanceResponse({ Balance: '10.50' }).balance).toBe(10.5)
    expect(normalizeBalanceResponse({ prepaid_balance: '5.00' }).balance).toBe(5)
    expect(normalizeBalanceResponse({ prepaidBalance: 7 }).balance).toBe(7)
    expect(DEFAULT_BALANCE_KEYS).toContain('balance')
    expect(DEFAULT_BALANCE_KEYS).toContain('prepaid_balance')
    expect(DEFAULT_BALANCE_KEYS).toContain('prepaidBalance')
  })

  it('still reads the plain balance key ahead of current_prepaid_balance when both exist', () => {
    const r = normalizeBalanceResponse({ balance: 1, current_prepaid_balance: 99 })
    expect(r.success).toBe(true)
    expect(r.balance).toBe(1)
  })
})

describe('probeBalanceFields — current_prepaid_balance diagnostics', () => {
  it('reports the live field under its own key', () => {
    expect(probeBalanceFields(LIVE_CHOICE)).toEqual({ current_prepaid_balance: 972.6487339312149 })
  })

  it('reports camelCase currentPrepaidBalance', () => {
    expect(probeBalanceFields({ currentPrepaidBalance: 42 })).toEqual({ current_prepaid_balance: 42 })
  })
})
