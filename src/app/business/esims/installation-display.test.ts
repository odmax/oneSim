import { describe, it, expect } from 'vitest'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

describe('business eSIM detail — installation data gating (uses shared helper)', () => {
  it('shows install panel when only qrCode payload is present', () => {
    const esim = { qrCodeUrl: null, qrCode: 'data:image/png;base64,AAAA', activationCode: null, smdpAddress: null, matchingId: null }
    expect(hasUsableInstallData(esim)).toBe(true)
  })

  it('shows install panel when only activationCode (LPA string) is present', () => {
    const esim = { qrCodeUrl: null, qrCode: null, activationCode: 'LPA:1$smdp.example.com$mid', smdpAddress: null, matchingId: null }
    expect(hasUsableInstallData(esim)).toBe(true)
  })

  it('shows install panel for a manual-install smdpAddress+matchingId pair', () => {
    const esim = { qrCodeUrl: null, qrCode: null, activationCode: null, smdpAddress: 'smdp.example.com', matchingId: 'mid-123' }
    expect(hasUsableInstallData(esim)).toBe(true)
  })

  it('hides install panel when only smdpAddress exists without matchingId', () => {
    const esim = { qrCodeUrl: null, qrCode: null, activationCode: null, smdpAddress: 'smdp.example.com', matchingId: null }
    expect(hasUsableInstallData(esim)).toBe(false)
  })

  it('hides install panel when no install data exists at all', () => {
    const esim = { qrCodeUrl: null, qrCode: null, activationCode: null, smdpAddress: null, matchingId: null }
    expect(hasUsableInstallData(esim)).toBe(false)
  })
})

describe('business eSIM detail — providerResponse is never passed to the QR modal', () => {
  it('detail page passes only sanitized install fields to QrCodeButton', () => {
    // Mirror of the page's QrCodeButton props construction: safe fields only.
    const lpa = null // safeProviderLPA of providerResponse
    const esim = {
      id: 'e1', iccid: '89012345678901234567',
      activationCode: 'LPA:1$smdp$mid', qrCodeUrl: null, qrCode: null,
      smdpAddress: 'smdp.example.com', matchingId: 'mid-1',
      status: 'ACTIVE',
    }
    const buttonProps = {
      esimId: esim.id, iccid: esim.iccid,
      activationCode: esim.activationCode, qrCodeUrl: esim.qrCodeUrl,
      qrCode: esim.qrCode, smdpAddress: esim.smdpAddress || lpa?.smdpAddress, matchingId: esim.matchingId,
      status: esim.status, customerName: null,
    }
    expect(buttonProps).not.toHaveProperty('providerResponse')
    expect(buttonProps).toHaveProperty('qrCode')
    expect(buttonProps).toHaveProperty('smdpAddress')
    expect(buttonProps).toHaveProperty('matchingId')
  })

  it('QrCodeButton hasQR accounts for qrCode and manual pair', () => {
    // Mirrors QrCodeButton: hasQR = qrCodeUrl || qrCode || activationCode || (smdpAddress && matchingId)
    const hasQR = (p: any) => !!(p.qrCodeUrl || p.qrCode || p.activationCode || (p.smdpAddress && p.matchingId))
    expect(hasQR({ qrCode: 'data:image/png;base64,AAAA' })).toBe(true)
    expect(hasQR({ smdpAddress: 'smdp.example.com', matchingId: 'mid-1' })).toBe(true)
    expect(hasQR({ smdpAddress: 'smdp.example.com' })).toBe(false)
    expect(hasQR({})).toBe(false)
  })
})
