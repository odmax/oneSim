import { describe, it, expect } from 'vitest'
import { buildComparisonKey, groupByComparisonKey } from './comparison-key'

describe('buildComparisonKey', () => {
  it('data-only plan produces correct key', () => {
    const key = buildComparisonKey({ country: 'South Africa', dataGB: 5, validityDays: 30 })
    expect(key).toBe('SOUTH_AFRICA|DATA_ONLY|5120MB|30D|VOICE_0|SMS_0')
  })

  it('5GB normalizes to 5120MB', () => {
    const key = buildComparisonKey({ country: 'ZA', dataGB: 5, validityDays: 30 })
    expect(key).toContain('5120MB')
  })

  it('1024MB stays as 1024MB', () => {
    const key = buildComparisonKey({ country: 'ZA', dataMB: 1024, validityDays: 30 })
    expect(key).toContain('1024MB')
  })

  it('30 Day and 30 Days produce same key', () => {
    const k1 = buildComparisonKey({ country: 'ZA', dataGB: 1, validityDays: 30 })
    expect(k1).toContain('30D')
  })

  it('voice + SMS plan produces VOICE_DATA_SMS', () => {
    const key = buildComparisonKey({ country: 'US', dataGB: 10, validityDays: 7, voiceMinutes: 100, smsCount: 50 })
    expect(key).toContain('VOICE_DATA_SMS')
    expect(key).toContain('VOICE_100')
    expect(key).toContain('SMS_50')
  })

  it('null voice/SMS defaults to 0', () => {
    const key = buildComparisonKey({ country: 'US', dataGB: 1, validityDays: 1 })
    expect(key).toContain('VOICE_0|SMS_0')
  })

  it('regional plan uses region as country', () => {
    const key = buildComparisonKey({ region: 'EUROPE', dataGB: 3, validityDays: 15 })
    expect(key).toContain('EUROPE')
  })

  it('empty country defaults to GLOBAL', () => {
    const key = buildComparisonKey({ dataGB: 1, validityDays: 7 })
    expect(key).toContain('GLOBAL|')
  })

  it('whitespace country normalized', () => {
    const key = buildComparisonKey({ country: '  south  africa ', dataGB: 1, validityDays: 7 })
    expect(key).toContain('SOUTH_AFRICA')
  })
})

describe('groupByComparisonKey', () => {
  it('groups same-key plans together', () => {
    const items = [
      { id: 'a', comparisonKey: 'ZA|DATA_ONLY|5120MB|30D|VOICE_0|SMS_0' },
      { id: 'b', comparisonKey: 'ZA|DATA_ONLY|5120MB|30D|VOICE_0|SMS_0' },
      { id: 'c', comparisonKey: 'US|DATA_ONLY|1024MB|7D|VOICE_0|SMS_0' },
    ]
    const groups = groupByComparisonKey(items)
    expect(groups.size).toBe(2)
    expect(groups.get(items[0].comparisonKey)?.length).toBe(2)
    expect(groups.get(items[2].comparisonKey)?.length).toBe(1)
  })

  it('separates different plan types', () => {
    const k1 = buildComparisonKey({ country: 'ZA', dataGB: 5, validityDays: 30 })
    const k2 = buildComparisonKey({ country: 'ZA', dataGB: 5, validityDays: 30, voiceMinutes: 100, smsCount: 50 })
    expect(k1).not.toBe(k2)
  })

  it('same plan from different providers grouped together', () => {
    const k = buildComparisonKey({ country: 'Nigeria', dataGB: 1, validityDays: 7 })
    const items = [
      { id: 'airhub-123', comparisonKey: k },
      { id: 'choice-456', comparisonKey: k },
      { id: 'ibasis-789', comparisonKey: k },
    ]
    const groups = groupByComparisonKey(items)
    expect(groups.size).toBe(1)
    expect(groups.get(k)?.length).toBe(3)
  })
})
