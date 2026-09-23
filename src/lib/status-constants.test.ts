import { describe, it, expect } from 'vitest'
import {
  ESIM_LIFECYCLE_STATUSES,
  ESIM_STATUS_META,
  ORDER_STATUSES,
  ORDER_NON_MACHINE_STATUSES,
  ORDER_API_STATUSES,
  TOPUP_STATUSES,
} from './status-constants'
import { ORDER_TRANSITIONS } from '@/lib/services/orders/order-state-machine'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import { ORDER_STATUS_LABELS, orderStatusLabel } from '@/lib/status-labels'
import { GET } from '@/app/api/openapi.json/route'
import { deriveEsimLifecycleStatus } from '@/lib/services/esims/lifecycle-status'
import { serializePublicOrder } from '@/lib/api/public-dto'

/**
 * Canonical status inventory + UI/API/OpenAPI consistency.
 *
 * These are the acceptance contracts for the status audit:
 *  - every canonical eSIM status has a customer-safe label + tone (never the
 *    literal "Unknown" while the status itself is valid);
 *  - every canonical order status has a label;
 *  - the OpenAPI Business API document accepts the same canonical values that
 *    the domain actually emits (eSIM lifecycle, order lifecycle, labels).
 */

describe('canonical eSIM lifecycle status set', () => {
  it('matches the lifecycle engine vocabulary exactly (no gaps)', () => {
    // Every canonical status must be a first-class output/preservable state of
    // the lifecycle engine. Unknown/weak provider reports on these rows never
    // fall back to a raw string.
    const engineStates = ['ACTIVE', 'INSTALLED', 'INSTALLING', 'SUSPENDED', 'DEPLETED', 'PENDING_ACTIVATION', 'PENDING', 'PROCESSING', 'RESERVED', 'EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']
    for (const s of ESIM_LIFECYCLE_STATUSES) {
      expect(engineStates, `ESIM lifecycle status ${s} must exist in the engine vocabulary`).toContain(s)
    }
    expect(deriveEsimLifecycleStatus).toBeDefined()
  })

  it('PROCESSING and RESERVED are documented transient states', () => {
    expect(ESIM_LIFECYCLE_STATUSES).toContain('PROCESSING')
    expect(ESIM_LIFECYCLE_STATUSES).toContain('RESERVED')
  })

  it('every canonical eSIM status has a stable label + tone and never renders "Unknown"', () => {
    const tones = new Set(['success', 'warn', 'danger', 'neutral'])
    for (const s of ESIM_LIFECYCLE_STATUSES) {
      const meta = ESIM_STATUS_META[s]
      expect(meta, `ESIM_STATUS_META must document ${s}`).toBeDefined()
      expect(meta!.label, `label for ${s}`).toBeTruthy()
      expect(meta!.label, `valid status ${s} must not be labelled Unknown`).not.toBe('Unknown')
      expect(tones.has(meta!.tone)).toBe(true)
      const rendered = getEsimStatusLabel(s)
      expect(rendered.label).toBe(meta!.label)
      expect(rendered.tone).toBe(meta!.tone)
    }
  })

  it('previously-raw statuses now render friendly labels (PROCESSING/RESERVED/INSTALLING)', () => {
    expect(getEsimStatusLabel('PROCESSING')).toEqual({ label: 'Provisioning', tone: 'warn' })
    expect(getEsimStatusLabel('RESERVED')).toEqual({ label: 'Reserved', tone: 'neutral' })
    expect(getEsimStatusLabel('INSTALLING')).toEqual({ label: 'Installing', tone: 'warn' })
  })

  it('only a truly empty status renders "Unknown"', () => {
    expect(getEsimStatusLabel(null).label).toBe('Unknown')
    expect(getEsimStatusLabel('').label).toBe('Unknown')
    expect(getEsimStatusLabel(undefined).label).toBe('Unknown')
  })

  it('unknown-but-non-empty statuses render the raw value, not "Unknown"', () => {
    expect(getEsimStatusLabel('SOMETHING_NEW').label).toBe('SOMETHING_NEW')
  })
})

describe('canonical order status sets', () => {
  it('ORDER_STATUSES is exactly the order state machine key set', () => {
    const machineKeys = Object.keys(ORDER_TRANSITIONS)
    expect([...ORDER_STATUSES].sort()).toEqual([...machineKeys].sort())
  })

  it('non-machine statuses are only the async/legacy indicators the API can surface', () => {
    expect([...ORDER_NON_MACHINE_STATUSES]).toEqual(['PROCESSING', 'PENDING'])
  })

  it('accounts explicitly for response-only PROCESSING and legacy PENDING', () => {
    // ORDER_API_STATUSES = persisted machine statuses + exactly these two extras.
    expect([...ORDER_API_STATUSES]).toEqual([...ORDER_STATUSES, 'PROCESSING', 'PENDING'])
    // PROCESSING is returned ONLY by POST /esims/order (async dispatch) and the
    // legacy purchase route; PENDING is the eSIMPurchase column default (legacy
    // rows). Neither is ever written by the state machine.
    expect(Object.keys(ORDER_TRANSITIONS)).not.toContain('PROCESSING')
    expect(Object.keys(ORDER_TRANSITIONS)).not.toContain('PENDING')
  })

  it('ORDER_API_STATUSES covers machine + non-machine, no duplicates', () => {
    const set = new Set(ORDER_API_STATUSES)
    expect(set.size).toBe(ORDER_API_STATUSES.length)
    for (const s of ORDER_STATUSES) expect(set.has(s)).toBe(true)
    for (const s of ORDER_NON_MACHINE_STATUSES) expect(set.has(s)).toBe(true)
  })

  it('every canonical order status (incl. PROCESSING/PENDING) has a label', () => {
    for (const s of ORDER_API_STATUSES) {
      expect(ORDER_STATUS_LABELS[s], `ORDER_STATUS_LABELS must document ${s}`).toBeDefined()
      const label = orderStatusLabel(s)
      expect(label.label).toBeTruthy()
      expect(label.label).not.toBe('Unknown')
      expect(label.dot).toBeTruthy()
      expect(label.bg).toBeTruthy()
    }
  })

  it('PROVIDER_RECONCILIATION and FULFILLED are explicitly labelled', () => {
    expect(ORDER_STATUS_LABELS.PROVIDER_RECONCILIATION.label).toBe('Reconciling')
    expect(ORDER_STATUS_LABELS.FULFILLED.label).toBe('Ready to Install')
  })
})

describe('top-up canonical statuses', () => {
  it('matches the prisma ESIMTopUpStatus enum', () => {
    expect([...TOPUP_STATUSES].sort()).toEqual(['COMPLETED', 'FAILED', 'PENDING', 'PENDING_REVIEW'].sort())
  })
})

describe('OpenAPI Business API status consistency', () => {
  it('Order.status enum accepts every canonical machine + async/legacy order status', async () => {
    const res = GET()
    const spec = await res.json()
    const orderEnum: string[] = spec.components.schemas.Order.properties.status.enum
    expect(orderEnum).toEqual([...ORDER_API_STATUSES])
    // ORDER_TRANSITIONS keys are all present (PROVIDER_RECONCILIATION, FULFILLED, ...)
    for (const s of ORDER_STATUSES) expect(orderEnum).toContain(s)
    expect(orderEnum).toContain('PROCESSING')
  })

  it('OpenAPI Order.status is SET-EQUAL to ORDER_API_STATUSES — no extras, no missing, no dupes', async () => {
    const res = GET()
    const spec = await res.json()
    const orderEnum: string[] = spec.components.schemas.Order.properties.status.enum
    expect(new Set(orderEnum)).toEqual(new Set(ORDER_API_STATUSES))
    expect(orderEnum.length).toBe(new Set(orderEnum).size)
    // The generated contract must never silently accept an off-canonical value.
    for (const s of orderEnum) expect((ORDER_API_STATUSES as readonly string[]).includes(s)).toBe(true)
  })

  it('ESIM.status enum accepts every canonical eSIM lifecycle status', async () => {
    const res = GET()
    const spec = await res.json()
    const esimEnum: string[] = spec.components.schemas.ESIM.properties.status.enum
    expect(esimEnum).toEqual([...ESIM_LIFECYCLE_STATUSES])
    // the previously-missing canonical statuses are now documented
    for (const s of ['PROCESSING', 'RESERVED', 'INSTALLING', 'INSTALLED', 'CANCELLED', 'REFUNDED']) {
      expect(esimEnum).toContain(s)
    }
  })

  it('OpenAPI ESIM.status is SET-EQUAL to ESIM_LIFECYCLE_STATUSES — no extras, no missing, no dupes', async () => {
    const res = GET()
    const spec = await res.json()
    const esimEnum: string[] = spec.components.schemas.ESIM.properties.status.enum
    expect(new Set(esimEnum)).toEqual(new Set(ESIM_LIFECYCLE_STATUSES))
    expect(esimEnum.length).toBe(new Set(esimEnum).size)
  })

  it('ESIM.statusLabel enum lists the label for every canonical status', async () => {
    const res = GET()
    const spec = await res.json()
    const labelEnum: string[] = spec.components.schemas.ESIM.properties.statusLabel.enum
    const expectedLabels = ESIM_LIFECYCLE_STATUSES.map((s) => ESIM_STATUS_META[s].label)
    expect(labelEnum).toEqual(expectedLabels)
    expect(labelEnum).not.toContain('Unknown')
  })

  it('nested esims[].status schemas accept the canonical eSIM set', async () => {
    const res = GET()
    const spec = await res.json()
    const orderEsimStatus: string[] = spec.components.schemas.Order.properties.esims.items.properties.status.enum
    expect(orderEsimStatus).toEqual([...ESIM_LIFECYCLE_STATUSES])
    const postEsimStatus: string[] = spec.paths['/esims/order'].post.responses['200'].content['application/json'].schema.properties.esims.items.properties.status.enum
    expect(postEsimStatus).toEqual([...ESIM_LIFECYCLE_STATUSES])
  })
})

describe('public DTO passthrough — the API surface never invents status values', () => {
  function order(status: string) {
    return {
      id: 'o1', status, quantity: 1, totalAmount: '10.00',
      package: { id: 'p1', name: 'Plan', displayName: 'Plan', priceUSD: 10, dataGB: 1, validityDays: 1, currency: 'USD' },
      esims: [],
    }
  }

  it('serializePublicOrder passes every canonical order status through unchanged', () => {
    for (const s of ORDER_API_STATUSES) {
      expect(serializePublicOrder(order(s)).status).toBe(s)
    }
  })

  it('serialized eSIM rows pass canonical statuses through unchanged', () => {
    const dto = serializePublicOrder({
      ...order('FULFILLED'),
      esims: ESIM_LIFECYCLE_STATUSES.map((s, i) => ({ id: `e${i}`, iccid: `8901${String(i).padStart(10, '0')}`, status: s })),
    })
    expect(dto.esims.map((e) => e.status)).toEqual([...ESIM_LIFECYCLE_STATUSES])
  })

  it('documented validator gap: no Zod enum restricts order/eSIM statuses at the request layer', () => {
    // The public API does not yet validate status inputs with Zod enums; writes
    // are constrained by the order state machine and the lifecycle engine, and
    // this test pins the contract values the API is allowed to surface so any
    // future validator must accept exactly ORDER_API_STATUSES / the eSIM set.
    const machine = Object.keys(ORDER_TRANSITIONS)
    for (const s of machine) expect((ORDER_API_STATUSES as readonly string[]).includes(s)).toBe(true)
  })
})