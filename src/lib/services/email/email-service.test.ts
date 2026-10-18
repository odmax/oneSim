import { describe, it, expect } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { vi } from 'vitest'
import { renderTemplate } from './email-service'

const ICCID = '89012345678901234567'
const ACTIVATION_CODE = 'LPA:1$smdp.example$ONESPACE-ABCD-1234'

describe('email-service redaction — qr-ready template', () => {
  it('masks the full ICCID and never embeds a raw activation code', () => {
    const html = renderTemplate('qr-ready', {
      customerName: 'Test',
      packageName: '5GB Plan',
      iccid: ICCID,
      activationCode: ACTIVATION_CODE,
      qrCodeUrl: 'https://cdn.example/qr.png',
    })

    expect(html).not.toContain(ICCID)
    expect(html).not.toContain(ACTIVATION_CODE)
    expect(html).not.toContain('LPA:')
    expect(html).toContain('8901••••4567')
    // Only a masked token of the activation code is shown.
    expect(html).toContain('1234')
    expect(html).not.toContain('ONESPACE-ABCD')
  })

  it('still renders the QR image for authorized installation', () => {
    const html = renderTemplate('qr-ready', { qrCodeUrl: 'https://cdn.example/qr.png', iccid: ICCID })
    expect(html).toContain('https://cdn.example/qr.png')
    expect(html).toContain('8901••••4567')
  })

  it('handles missing sensitive values without crashing', () => {
    const html = renderTemplate('qr-ready', {})
    expect(html).toContain('Your eSIM is Ready!')
  })
})