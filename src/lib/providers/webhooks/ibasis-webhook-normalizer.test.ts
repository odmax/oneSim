import { describe, it, expect } from 'vitest'
import { normalizeIbasisWebhook } from '@/lib/providers/webhooks/ibasis-webhook-normalizer'

describe('iBASIS webhook normalizer', () => {
  it('1. activation status pending → USAGE_UPDATED (processing)', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-1', subscription_activation_id: 'act-1', status: 'pending',
    })
    expect(r.eventType).toBe('USAGE_UPDATED')
    expect(r.externalEventId).toBe('evt-1')
    expect(r.providerStatus).toBe('pending')
  })

  it('2. activation status processing → USAGE_UPDATED', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-2', subscription_activation_id: 'act-2', status: 'processing',
    })
    expect(r.eventType).toBe('USAGE_UPDATED')
  })

  it('3. activation status reserved → USAGE_UPDATED', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e3', subscription_activation_id: 'a3', status: 'reserved' }).eventType).toBe('USAGE_UPDATED')
  })

  it('4. activation status completed → ESIM_ACTIVATED', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-4', subscription_activation_id: 'act-4', status: 'completed',
    })
    expect(r.eventType).toBe('ESIM_ACTIVATED')
    expect(r.providerStatus).toBe('completed')
  })

  it('5. activation status rejected → PROVIDER_ERROR', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e5', subscription_activation_id: 'a5', status: 'rejected' }).eventType).toBe('PROVIDER_ERROR')
  })

  it('6. activation status failed → PROVIDER_ERROR', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e6', subscription_activation_id: 'a6', status: 'failed' }).eventType).toBe('PROVIDER_ERROR')
  })

  it('7. subscription activated → ESIM_ACTIVATED', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-7', subscription_activation_id: 'act-7', subscription_id: 'sub-7',
    })
    expect(r.eventType).toBe('ESIM_ACTIVATED')
    expect(r.providerStatus).toBe('completed')
  })

  it('8. subscription activated does NOT mark device installed', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-8', subscription_activation_id: 'act-8', subscription_id: 'sub-8',
    })
    // ESIM_ACTIVATED is provider-level — not device-level
    expect(r.eventType).toBe('ESIM_ACTIVATED')
  })

  it('9. DATA usage → USAGE_UPDATED with MB conversion (10,485,760 bytes = 10 MB)', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-9', type: 'DATA', usage: 10485760,
      timestamp: '2026-01-01T00:00:00Z', subscription_id: 'sub-9', plan: 'plan-9',
    })
    expect(r.eventType).toBe('USAGE_UPDATED')
    expect(r.dataUsedMB).toBe(10)
  })

  it('10. DATA usage — smaller value (524,288 bytes = 0.5 MB)', () => {
    const r = normalizeIbasisWebhook({ notification_id: 'e10', type: 'DATA', usage: 524288, subscription_id: 's10' })
    expect(r.dataUsedMB).toBe(0.5)
  })

  it('11. negative usage rejected → UNKNOWN', () => {
    const r = normalizeIbasisWebhook({ notification_id: 'e11', type: 'DATA', usage: -100, subscription_id: 's11' })
    expect(r.eventType).toBe('UNKNOWN')
  })

  it('12. NaN/Infinity usage rejected → UNKNOWN', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e12', type: 'DATA', usage: 'abc' }).eventType).toBe('UNKNOWN')
    expect(normalizeIbasisWebhook({ notification_id: 'e13', type: 'DATA', usage: Infinity }).eventType).toBe('UNKNOWN')
  })

  it('13. VOICE usage → UNKNOWN (data-only offer)', () => {
    const r = normalizeIbasisWebhook({ notification_id: 'e14', type: 'VOICE', usage: 100 })
    expect(r.eventType).toBe('UNKNOWN')
  })

  it('14. SMS usage → UNKNOWN', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e15', type: 'SMS', usage: 1 }).eventType).toBe('UNKNOWN')
  })

  it('15. threshold notification → USAGE_UPDATED with remaining MB (52,428,800 bytes = 50 MB)', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'evt-16', timestamp: '2026-01-01T00:00:00Z',
      plan: 'plan-16', threshold: 52428800,
      balance: { messages: 0, voice: 0, data: 52428800 },
    })
    expect(r.eventType).toBe('USAGE_UPDATED')
    expect(r.dataRemainingMB).toBe(50)
  })

  it('16. threshold with invalid balance → UNKNOWN', () => {
    expect(normalizeIbasisWebhook({ notification_id: 'e17', balance: { data: -1 } }).eventType).toBe('UNKNOWN')
  })

  it('17. unknown payload → UNKNOWN', () => {
    expect(normalizeIbasisWebhook({}).eventType).toBe('UNKNOWN')
    expect(normalizeIbasisWebhook(null).eventType).toBe('UNKNOWN')
  })

  it('18. notification_id used as stable externalEventId', () => {
    const r = normalizeIbasisWebhook({ notification_id: 'evt-18', subscription_activation_id: 'a18', status: 'completed' })
    expect(r.externalEventId).toBe('evt-18')
  })

  it('19. no secrets or personal identifiers in event', () => {
    const r = normalizeIbasisWebhook({
      notification_id: 'e19', subscription_activation_id: 'a19', status: 'pending',
    })
    expect(JSON.stringify(r)).not.toContain('token')
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(JSON.stringify(r)).not.toContain('password')
  })

  it('20. unknown status preserved safely', () => {
    const r = normalizeIbasisWebhook({ notification_id: 'e20', subscription_activation_id: 'a20', status: 'mystery_status' })
    expect(r.externalEventId).toBe('e20')
    expect(r.raw.status).toBe('mystery_status')
  })
})
