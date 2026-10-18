import { describe, it, expect } from 'vitest'
import { parseDecimalInput, isPositivePrice } from './decimal-input'

describe('parseDecimalInput — locale-safe decimal parsing', () => {
  it('parses comma-decimal like 21,49 exactly as 21.49', () => {
    expect(parseDecimalInput('21,49')).toBe(21.49)
  })

  it('parses dot-decimal like 21.49 exactly as 21.49', () => {
    expect(parseDecimalInput('21.49')).toBe(21.49)
  })

  it('never turns 21,49 into 2149', () => {
    expect(parseDecimalInput('21,49')).not.toBe(2149)
  })

  it('never turns 21,49 into 21', () => {
    expect(parseDecimalInput('21,49')).not.toBe(21)
  })

  it('never returns zero for a valid comma-decimal', () => {
    expect(parseDecimalInput('21,49')).not.toBe(0)
  })

  it('never returns NaN for a valid comma-decimal', () => {
    expect(Number.isNaN(parseDecimalInput('21,49'))).toBe(false)
    expect(Number.isNaN(parseDecimalInput('0,99'))).toBe(false)
  })

  it('handles integer input', () => {
    expect(parseDecimalInput('30')).toBe(30)
  })

  it('treats thousands separators correctly (1,234.56)', () => {
    expect(parseDecimalInput('1,234.56')).toBe(1234.56)
  })

  it('treats commas as thousands when followed by 3 digits (1,234)', () => {
    expect(parseDecimalInput('1,234')).toBe(1234)
  })

  it('rejects empty and whitespace-only input', () => {
    expect(parseDecimalInput('')).toBeNull()
    expect(parseDecimalInput('   ')).toBeNull()
    expect(parseDecimalInput(undefined)).toBeNull()
    expect(parseDecimalInput(null)).toBeNull()
  })

  it('rejects garbage input safely', () => {
    expect(parseDecimalInput('abc')).toBeNull()
    expect(parseDecimalInput('21,4a')).toBeNull()
  })

  it('accepts finite numeric input directly', () => {
    expect(parseDecimalInput(21.49)).toBe(21.49)
  })

  it('rejects infinite/non-finite numbers', () => {
    expect(parseDecimalInput(Number.NaN)).toBeNull()
    expect(parseDecimalInput(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('parses a bare comma-decimal like 0,99', () => {
    expect(parseDecimalInput('0,99')).toBe(0.99)
  })

  it('distinguishes a 2-digit decimal comma from a 3-digit thousands comma', () => {
    expect(parseDecimalInput('21,49')).toBe(21.49)
    expect(parseDecimalInput('1,234')).toBe(1234)
    expect(parseDecimalInput('0,99')).toBe(0.99)
  })
})

describe('isPositivePrice', () => {
  it('is true only for finite positive values', () => {
    expect(isPositivePrice(1)).toBe(true)
    expect(isPositivePrice(21.49)).toBe(true)
    expect(isPositivePrice(0)).toBe(false)
    expect(isPositivePrice(-1)).toBe(false)
    expect(isPositivePrice(null)).toBe(false)
  })
})