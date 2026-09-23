import { describe, it, expect } from 'vitest'
import { adminEsimStatusBadge, adminOrderStatusBadge } from './status-badges'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import { ESIM_LIFECYCLE_STATUSES, ESIM_STATUS_META, ORDER_API_STATUSES } from './status-constants'

describe('adminEsimStatusBadge — every canonical status renders a label, never a raw identifier', () => {
  it('labels every canonical eSIM status with the canonical label (never raw, never Unknown)', () => {
    for (const s of ESIM_LIFECYCLE_STATUSES) {
      const badge = adminEsimStatusBadge(s)
      expect(badge.label, `label for ${s}`).toBe(getEsimStatusLabel(s).label)
      expect(badge.label).not.toBe(s) // never the raw identifier
      expect(badge.label).not.toBe('Unknown')
      expect(badge.className, `className for ${s}`).toBeTruthy()
    }
  })

  it('labels every canonical eSIM status with a customer-safe text from the shared meta', () => {
    for (const s of ESIM_LIFECYCLE_STATUSES) {
      expect(adminEsimStatusBadge(s).label).toBe(ESIM_STATUS_META[s].label)
    }
  })

  it('previously-unmapped statuses now render with color and label (no gray raw fallbacks)', () => {
    const previouslyRaw = ['DEPLETED', 'REFUNDED', 'PROCESSING', 'RESERVED', 'INSTALLING', 'INSTALLED', 'CANCELLED']
    for (const s of previouslyRaw) {
      const badge = adminEsimStatusBadge(s)
      expect(badge.label).not.toBe(s)
      // Color present: the gray fallback is reserved for truly unknown values.
      expect(badge.className).toMatch(/bg-(red|rose|sky|blue|purple|teal)-100/)
    }
  })

  it('DEPLETED / REFUNDED are danger-toned; PROCESSING / RESERVED / INSTALLING are distinct', () => {
    expect(adminEsimStatusBadge('DEPLETED').className).toContain('bg-red-100')
    expect(adminEsimStatusBadge('REFUNDED').className).toContain('bg-rose-100')
    expect(adminEsimStatusBadge('PROCESSING').className).toContain('bg-blue-100')
    expect(adminEsimStatusBadge('RESERVED').className).toContain('bg-purple-100')
    expect(adminEsimStatusBadge('INSTALLING').className).toContain('bg-sky-100')
  })

  it('an unknown non-empty value shows the raw value but is never called Unknown', () => {
    const badge = adminEsimStatusBadge('SOMETHING_NEW')
    expect(badge.label).toBe('SOMETHING_NEW')
    expect(badge.className).toContain('bg-gray-100')
  })

  it('a null/empty eSIM status falls back to Unknown with a neutral tone (helper contract)', () => {
    expect(adminEsimStatusBadge(null).label).toBe('Unknown')
    expect(adminEsimStatusBadge('').label).toBe('Unknown')
  })
})

describe('adminOrderStatusBadge — every canonical order status renders a label', () => {
  it('labels every canonical order status (incl. PROCESSING/PENDING); never a raw identifier', () => {
    for (const s of ORDER_API_STATUSES) {
      const badge = adminOrderStatusBadge(s)
      expect(badge.label, `label for ${s}`).toBeTruthy()
      expect(badge.label).not.toBe(s)
      expect(badge.label).not.toBe('Unknown')
      expect(badge.className).toBeTruthy()
    }
  })

  it('PROVIDER_RECONCILIATION / PROCESSING / PARTIALLY_FULFILLED have dedicated colors', () => {
    expect(adminOrderStatusBadge('PROVIDER_RECONCILIATION').className).toContain('bg-purple-100')
    expect(adminOrderStatusBadge('PROCESSING').className).toContain('bg-blue-100')
    expect(adminOrderStatusBadge('PARTIALLY_FULFILLED').className).toContain('bg-amber-100')
    expect(adminOrderStatusBadge('FULFILLED').label).toBe('Ready to Install')
  })

  it('unknown order status renders the raw text with the neutral color', () => {
    const badge = adminOrderStatusBadge('MYSTERY')
    expect(badge.label).toBe('MYSTERY')
    expect(badge.className).toContain('bg-gray-100')
  })
})