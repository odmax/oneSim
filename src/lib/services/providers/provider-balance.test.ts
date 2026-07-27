import { describe, it, expect } from 'vitest'
import { extractNumericValue, extractStringValue, removeBalanceSnapshotFromConfig } from '@/lib/services/providers/provider-balance'

describe('extractNumericValue', () => {
  it('returns number value directly', () => {
    expect(extractNumericValue({ balance: 1250.50 }, ['balance'])).toBe(1250.50)
  })

  it('parses decimal numeric string', () => {
    expect(extractNumericValue({ balance: '999.99' }, ['balance'])).toBe(999.99)
  })

  it('trims surrounding whitespace', () => {
    expect(extractNumericValue({ balance: '  500  ' }, ['balance'])).toBe(500)
  })

  it('returns zero', () => {
    expect(extractNumericValue({ balance: 0 }, ['balance'])).toBe(0)
    expect(extractNumericValue({ balance: '0' }, ['balance'])).toBe(0)
  })

  it('returns negative number', () => {
    expect(extractNumericValue({ balance: -100 }, ['balance'])).toBe(-100)
  })

  it('returns null for empty value', () => {
    expect(extractNumericValue({ balance: '' }, ['balance'])).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(extractNumericValue({ balance: NaN }, ['balance'])).toBeNull()
  })

  it('returns null for Infinity', () => {
    expect(extractNumericValue({ balance: Infinity }, ['balance'])).toBeNull()
    expect(extractNumericValue({ balance: -Infinity }, ['balance'])).toBeNull()
  })

  it('rejects boolean', () => {
    expect(extractNumericValue({ balance: true }, ['balance'])).toBeNull()
  })

  it('rejects object', () => {
    expect(extractNumericValue({ balance: {} }, ['balance'])).toBeNull()
  })

  it('rejects partially numeric string', () => {
    expect(extractNumericValue({ balance: '123abc' }, ['balance'])).toBeNull()
  })

  it('tries candidates in order', () => {
    expect(extractNumericValue({ b: 1, a: 5 }, ['a', 'b'])).toBe(5)
  })

  it('falls through invalid to valid candidate', () => {
    expect(extractNumericValue({ b: 'N/A', a: 42 }, ['b', 'a'])).toBe(42)
  })

  it('resolves nested dot-path', () => {
    expect(extractNumericValue({ data: { wallet: { available: 100 } } }, ['data.wallet.available'])).toBe(100)
  })

  it('returns null when no candidate matches', () => {
    expect(extractNumericValue({ x: 'nope' }, ['balance'])).toBeNull()
  })

  it('input remains unmodified', () => {
    const input = { balance: '123.45' }
    extractNumericValue(input, ['balance'])
    expect(input).toEqual({ balance: '123.45' })
  })
})

describe('extractStringValue', () => {
  it('returns string directly', () => {
    expect(extractStringValue({ currency: 'USD' }, ['currency'])).toBe('USD')
  })

  it('converts number to string', () => {
    expect(extractStringValue({ currency: 1 }, ['currency'])).toBe('1')
  })

  it('trims whitespace', () => {
    expect(extractStringValue({ currency: '  EUR  ' }, ['currency'])).toBe('EUR')
  })

  it('rejects empty string', () => {
    expect(extractStringValue({ currency: '' }, ['currency'])).toBeNull()
  })

  it('resolves nested dot-path', () => {
    expect(extractStringValue({ data: { currency: 'GBP' } }, ['data.currency'])).toBe('GBP')
  })

  it('returns null when no candidate matches', () => {
    expect(extractStringValue({}, ['currency'])).toBeNull()
  })
})

describe('removeBalanceSnapshotFromConfig', () => {
  it('removes balanceSnapshot from config', () => {
    const config = { apiKey: 'abc', balanceSnapshot: { balance: 100 }, endpoint: '/api' }
    const result = removeBalanceSnapshotFromConfig(config)
    expect(result).toEqual({ apiKey: 'abc', endpoint: '/api' })
    expect(result).not.toHaveProperty('balanceSnapshot')
  })

  it('preserves unrelated config intact', () => {
    const config = { _legacyConnector: true, authBaseUrl: 'https://example.com', fieldMappings: {}, balanceSnapshot: {} }
    const result = removeBalanceSnapshotFromConfig(config)
    expect(result).toEqual({ _legacyConnector: true, authBaseUrl: 'https://example.com', fieldMappings: {} })
  })

  it('handles config without balanceSnapshot', () => {
    const config = { apiKey: 'abc' }
    const result = removeBalanceSnapshotFromConfig(config)
    expect(result).toEqual({ apiKey: 'abc' })
  })

  it('returns null for null config', () => {
    expect(removeBalanceSnapshotFromConfig(null)).toBeNull()
  })

  it('returns null for non-object config', () => {
    expect(removeBalanceSnapshotFromConfig('string')).toBeNull()
  })

  it('does not mutate original', () => {
    const original = { balanceSnapshot: { balance: 500 }, key: 'val' }
    removeBalanceSnapshotFromConfig(original)
    expect(original).toHaveProperty('balanceSnapshot')
  })
})
