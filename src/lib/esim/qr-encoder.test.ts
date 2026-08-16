import { describe, it, expect } from 'vitest'
import { generateQrMatrix, renderQrPayload, qrSizeForText, qrMatrixToRgba, qrRgbaDimension } from './qr-encoder'
import { classifyQrValue, isLpaPayload, isHttpUrl, buildInstallationPresentation } from './installation-data'
import jsQR from 'jsqr'

/** Encode → decode round trip via the independent jsqr decoder. */
function roundTrip(payload: string): string {
  const matrix = generateQrMatrix(payload)
  const px = qrMatrixToRgba(matrix, 8, 4)
  const dim = qrRgbaDimension(matrix, 8, 4)
  const result = jsQR(px, dim, dim)
  if (!result) throw new Error(`jsQR could not decode payload (len=${payload.length}): ${payload.slice(0, 40)}`)
  return result.data
}

// NOTE: qr-encoder re-exports classifier helpers for convenience below.

describe('qr-encoder — structural correctness', () => {
  it('produces a square matrix with standard QR dimensions', () => {
    const m = generateQrMatrix('LPA:1$smdp.example.com$1234567890')
    expect(m.length).toBe(m[0].length)
    expect(m.length).toBeGreaterThanOrEqual(21)
    // version 1 => 21 modules; longer payloads grow
    expect(m.length).toBe(qrSizeForText('LPA:1$smdp.example.com$1234567890'))
  })

  it('has a finder pattern at the top-left corner (7x7 ring with 3x3 center)', () => {
    const m = generateQrMatrix('hello')
    // Center of top-left finder at (3,3): should be dark.
    expect(m[3][3]).toBe(true)
    // Corner (0,0) dark, (1,1) dark (ring), (3,1) should be dark (vertical bar)
    expect(m[0][0]).toBe(true)
    // Separator ring: (7,0) should be false (outside ring)
    expect(m[7][0]).toBe(false)
  })

  it('renders an SVG data URL that starts with data:image/svg+xml', () => {
    const url = renderQrPayload('LPA:1$smdp.example.com$1234')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('throws for payloads too large for the largest supported version', () => {
    expect(() => generateQrMatrix('x'.repeat(3000))).toThrow()
  })
})

describe('QR round-trip decode (independent jsqr decoder)', () => {
  it('decodes an LPA payload exactly', () => {
    expect(roundTrip('LPA:1$rsp.example.com$ABCDEF1234567890')).toBe('LPA:1$rsp.example.com$ABCDEF1234567890')
  })

  it('decodes a bare LPA payload (no LPA: prefix) exactly', () => {
    expect(roundTrip('1$rsp.example.com$ABCDEF1234567890')).toBe('1$rsp.example.com$ABCDEF1234567890')
  })

  it('decodes a realistic long SM-DP hostname + matching-id payload', () => {
    const payload = 'LPA:1$consumer.rsp.global.example.com$TN2023041314334227F18CAD'
    expect(roundTrip(payload)).toBe(payload)
  })

  it('decodes mixed-case alphanumeric + symbols exactly', () => {
    const payload = 'LPA:1$SMDP.Host.Example$AbC123_-xYz.9876'
    expect(roundTrip(payload)).toBe(payload)
  })

  it('decodes a payload near the observed LPA max length', () => {
    // ~150-char LPA payload (well within v10 capacity but large enough to stress).
    const mid = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'
    const payload = `LPA:1$rsp.some-very-long-provider-host.example.com$${mid}${mid}${mid}`
    expect(payload.length).toBeGreaterThan(100)
    expect(roundTrip(payload)).toBe(payload)
  })

  it('throws a clear controlled error for payloads above supported capacity', () => {
    // qrcode supports up to version 40; only a genuinely oversized payload throws.
    expect(() => generateQrMatrix('x'.repeat(3000))).toThrow(/too big|too large/i)
  })
})

describe('qr/install classification (provider-neutral)', () => {  it('classifies an HTTP URL as QR_IMAGE_URL', () => {
    expect(classifyQrValue('https://provider.example/qr/123.png')).toBe('QR_IMAGE_URL')
    expect(isHttpUrl('https://provider.example/qr.png')).toBe(true)
    expect(isHttpUrl('LPA:1$smdp$code')).toBe(false)
  })

  it('classifies an LPA payload as QR_PAYLOAD', () => {
    expect(isLpaPayload('LPA:1$smdp.example.com$123456')).toBe(true)
    expect(isLpaPayload('1$smdp.example.com$123456')).toBe(true)
    expect(classifyQrValue('LPA:1$smdp.example.com$123456')).toBe('QR_PAYLOAD')
  })

  it('classifies a plain code as ACTIVATION_CODE', () => {
    expect(classifyQrValue('TN2023041314334227F18CAD')).toBe('ACTIVATION_CODE')
  })

  it('buildInstallationPresentation distinguishes image vs payload vs manual', () => {
    expect(buildInstallationPresentation({ qrCodeUrl: 'https://x/qr.png' }).kind).toBe('QR_IMAGE_URL')
    // A payload mislabeled as qrCodeUrl is still recognized as a payload.
    expect(buildInstallationPresentation({ qrCodeUrl: 'LPA:1$smdp$123' }).kind).toBe('QR_PAYLOAD')
    expect(buildInstallationPresentation({ qrCode: 'LPA:1$smdp$123' }).kind).toBe('QR_PAYLOAD')
    expect(buildInstallationPresentation({ qrCodeUrl: 'LPA:1$smdp$123' }).qrPayload).toBe('LPA:1$smdp$123')
    expect(buildInstallationPresentation({ activationCode: 'CODE123', smdpAddress: 'smdp.x', matchingId: 'mid' }).kind).toBe('ACTIVATION_CODE')
    expect(buildInstallationPresentation({ smdpAddress: 'smdp.x', matchingId: 'mid' }).kind).toBe('MANUAL')
    expect(buildInstallationPresentation({}).kind).toBe('NONE')
  })
})
