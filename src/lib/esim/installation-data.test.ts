import { describe, it, expect } from 'vitest'
import { hasUsableInstallData, installationStatusFromData, extractInstallDataFromProviderResponse, mergeInstallData } from './installation-data'

describe('hasUsableInstallData', () => {
  it('is true for qrCode alone', () => {
    expect(hasUsableInstallData({ qrCode: 'data:image/png;base64,AAAA' })).toBe(true)
  })

  it('is true for qrCodeUrl alone', () => {
    expect(hasUsableInstallData({ qrCodeUrl: 'https://qr.example/q.png' })).toBe(true)
  })

  it('is true for activationCode alone', () => {
    expect(hasUsableInstallData({ activationCode: 'LPA:1$smdp$mid' })).toBe(true)
  })

  it('is true for a manual-install smdpAddress+matchingId pair', () => {
    expect(hasUsableInstallData({ smdpAddress: 'smdp.example.com', matchingId: 'mid-1' })).toBe(true)
  })

  it('is false for smdpAddress alone', () => {
    expect(hasUsableInstallData({ smdpAddress: 'smdp.example.com' })).toBe(false)
  })

  it('is false for empty/missing data', () => {
    expect(hasUsableInstallData(null)).toBe(false)
    expect(hasUsableInstallData({})).toBe(false)
  })

  it('installationStatusFromData maps to READY/PENDING', () => {
    expect(installationStatusFromData({ qrCodeUrl: 'x' })).toBe('READY')
    expect(installationStatusFromData({})).toBe('PENDING')
  })
})

describe('extractInstallDataFromProviderResponse', () => {
  it('extracts the whitelisted keys from a flat payload', () => {
    const out = extractInstallDataFromProviderResponse({
      lpa: 'LPA:1$smdp.example.com$mid',
      smdp: 'smdp.example.com',
      matchingId: 'mid-1',
      qr_code_url: 'https://qr.example/q.png',
      qrCode: 'data:image/png;base64,AAAA',
    })
    expect(out).toEqual({
      activationCode: 'LPA:1$smdp.example.com$mid',
      smdpAddress: 'smdp.example.com',
      matchingId: 'mid-1',
      qrCodeUrl: 'https://qr.example/q.png',
      qrCode: 'data:image/png;base64,AAAA',
    })
  })

  it('reads a nested activationData object', () => {
    const out = extractInstallDataFromProviderResponse({
      activationData: { activationCode: 'LPA:1$nested$mid', smdpAddress: 'nested.example.com', matching_id: 'n-mid' },
    })
    expect(out).toEqual({
      activationCode: 'LPA:1$nested$mid',
      smdpAddress: 'nested.example.com',
      matchingId: 'n-mid',
    })
  })

  it('parses a JSON string payload', () => {
    const out = extractInstallDataFromProviderResponse(JSON.stringify({ qrCodeUrl: 'https://qr.example/q.png' }))
    expect(out.qrCodeUrl).toBe('https://qr.example/q.png')
  })

  it('ignores non-whitelisted keys and malformed input', () => {
    expect(extractInstallDataFromProviderResponse({ apiToken: 'SECRET', subscriberId: '123' })).toEqual({})
    expect(extractInstallDataFromProviderResponse('not json')).toEqual({})
    expect(extractInstallDataFromProviderResponse(null)).toEqual({})
  })
})

describe('mergeInstallData', () => {
  it('fills missing values only, never overwrites existing data', () => {
    const out = mergeInstallData({ activationCode: 'KEEP' }, { activationCode: 'NEW', smdpAddress: 'smdp.example.com' })
    expect(out).toEqual({ smdpAddress: 'smdp.example.com' })
  })
})
