import { describe, it, expect } from 'vitest'
import { hasUsableInstallData, installationStatusFromData, extractInstallDataFromProviderResponse, mergeInstallData, normalizeConnectorInstallData, buildInstallationPresentation, classifyQrValue, isHttpUrl, isLpaPayload } from './installation-data'

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

  it('reads lpaProfile from a nested activationData object', () => {
    const out = extractInstallDataFromProviderResponse({
      activationData: { lpaProfile: 'LPA:1$nested$mid' },
    })
    expect(out).toEqual({ activationCode: 'LPA:1$nested$mid' })
  })

  it('maps qr_code_link to qrCodeUrl', () => {
    const out = extractInstallDataFromProviderResponse({ qr_code_link: 'https://qr.example/q.png' })
    expect(out).toEqual({ qrCodeUrl: 'https://qr.example/q.png' })
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

describe('normalizeConnectorInstallData', () => {
  it('reconciles plural arrays and singular fields into the canonical shape', () => {
    expect(normalizeConnectorInstallData({
      activationCodes: ['LPA:1$smdp.example.com$mid'],
      qrCodeUrls: ['https://qr.example/q.png'],
      smdpAddress: 'smdp.example.com',
      matchingId: 'mid-1',
    })).toEqual({
      activationCode: 'LPA:1$smdp.example.com$mid',
      qrCodeUrl: 'https://qr.example/q.png',
      smdpAddress: 'smdp.example.com',
      matchingId: 'mid-1',
    })
  })

  it('prefers the first plural activationCodes entry but singular qrCodeUrl', () => {
    expect(normalizeConnectorInstallData({ activationCodes: ['A', 'B'], activationCode: 'C' }).activationCode).toBe('A')
    expect(normalizeConnectorInstallData({ qrCodeUrls: ['https://a/q.png', 'https://b/q.png'], qrCodeUrl: 'https://c/q.png' }).qrCodeUrl).toBe('https://c/q.png')
  })

  it('maps a Choice activateESIM result (data.imsis[].activation_code / qr_code_link) into install fields', () => {
    // Choice activateESIM maps data.imsis[].activation_code → activationCodes and
    // data.imsis[0].qr_code_link → qrCodeUrl. The canonical normalizer then
    // produces the persisted ESIM fields.
    const out = normalizeConnectorInstallData({
      activationId: 'txn-1',
      iccids: ['89012345678901234567'],
      imsis: ['310410123456789'],
      activationCodes: ['LPA:1$smdp.example.com$mid'],
      qrCodeUrl: 'https://qr.example/q.png',
      status: 'ACTIVATED',
    })
    expect(out.activationCode).toBe('LPA:1$smdp.example.com$mid')
    expect(out.qrCodeUrl).toBe('https://qr.example/q.png')
    expect(out).not.toHaveProperty('activationId')
    expect(out).not.toHaveProperty('status')
  })

  it('drops empty/falsy values and never invents fields', () => {
    expect(normalizeConnectorInstallData({ activationCode: '', qrCode: undefined, smdpAddress: null, matchingId: '' }))
      .toEqual({})
  })

  it('never moves a field into a semantically different column', () => {
    const out = normalizeConnectorInstallData({ smdpAddress: 'smdp.example.com', qrCodeUrl: 'https://qr.example/q.png', qrCode: 'data:image/png;base64,AAAA' })
    expect(out.activationCode).toBeUndefined()
    expect(out.smdpAddress).toBe('smdp.example.com')
    expect(out.qrCodeUrl).toBe('https://qr.example/q.png')
    expect(out.qrCode).toBe('data:image/png;base64,AAAA')
  })

  it('handles null/undefined input', () => {
    expect(normalizeConnectorInstallData(null)).toEqual({})
    expect(normalizeConnectorInstallData(undefined)).toEqual({})
  })
})

describe('QR classification (provider-neutral)', () => {
  it('classifies an HTTP URL as QR_IMAGE_URL', () => {
    expect(isHttpUrl('https://provider.example/qr/123.png')).toBe(true)
    expect(isHttpUrl('LPA:1$smdp.example.com$123')).toBe(false)
    expect(classifyQrValue('https://provider.example/qr.png')).toBe('QR_IMAGE_URL')
    expect(classifyQrValue('data:image/png;base64,AAAA')).toBe('QR_IMAGE_URL')
  })

  it('classifies LPA payloads as QR_PAYLOAD', () => {
    expect(isLpaPayload('LPA:1$smdp.example.com$123456')).toBe(true)
    expect(isLpaPayload('1$smdp.example.com$123456')).toBe(true)
    expect(classifyQrValue('LPA:1$smdp.example.com$123456')).toBe('QR_PAYLOAD')
  })

  it('classifies a plain code as ACTIVATION_CODE', () => {
    expect(classifyQrValue('TN2023041314334227F18CAD')).toBe('ACTIVATION_CODE')
    expect(classifyQrValue('')).toBe('NONE')
    expect(classifyQrValue(null)).toBe('NONE')
  })
})

describe('buildInstallationPresentation (canonical install model)', () => {
  it('US-Matrix purchase: qrcodeString persisted as qrCode → presented as QR_PAYLOAD', () => {
    // US-Matrix activateESIM now maps qrcodeString → qrCode (not qrCodeUrl).
    const p = buildInstallationPresentation({
      activationCode: '1$smdp.example.com$mid',
      qrCode: 'LPA:1$smdp.example.com$mid',
      smdpAddress: 'smdp.example.com',
      matchingId: 'mid',
    })
    expect(p.kind).toBe('QR_PAYLOAD')
    expect(p.qrPayload).toBe('LPA:1$smdp.example.com$mid')
    expect(p.qrImageUrl).toBeNull()
    expect(p.activationCode).toBe('1$smdp.example.com$mid')
  })

  it('a payload mislabeled into qrCodeUrl is still recognized as a payload', () => {
    const p = buildInstallationPresentation({ qrCodeUrl: 'LPA:1$smdp.example.com$mid' })
    expect(p.kind).toBe('QR_PAYLOAD')
    expect(p.qrPayload).toBe('LPA:1$smdp.example.com$mid')
    expect(p.qrImageUrl).toBeNull()
  })

  it('Choice: qr_code_link as qrCodeUrl → QR_IMAGE_URL', () => {
    const p = buildInstallationPresentation({ qrCodeUrl: 'https://qr.example/q.png', activationCode: 'LPA:1$smdp$mid' })
    expect(p.kind).toBe('QR_IMAGE_URL')
    expect(p.qrImageUrl).toBe('https://qr.example/q.png')
  })

  it('manual-install pair → MANUAL', () => {
    const p = buildInstallationPresentation({ smdpAddress: 'smdp.example.com', matchingId: 'mid-1' })
    expect(p.kind).toBe('MANUAL')
  })

  it('activation code only → ACTIVATION_CODE', () => {
    const p = buildInstallationPresentation({ activationCode: 'CODE123' })
    expect(p.kind).toBe('ACTIVATION_CODE')
  })

  it('nothing → NONE', () => {
    expect(buildInstallationPresentation({}).kind).toBe('NONE')
    expect(buildInstallationPresentation(null).kind).toBe('NONE')
  })
})
