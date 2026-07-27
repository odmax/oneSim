import { describe, it, expect } from 'vitest'
import { normalizeChoiceWebhook, parseChoiceDate } from '@/lib/providers/webhooks/choice-webhook-normalizer'

describe('parseChoiceDate', () => {
  it('parses YYYY-MM-DD-HH.MM.SS format', () => {
    const result = parseChoiceDate('2026-01-15-14.30.00')
    expect(result).toBeDefined()
    expect(result).toContain('2026-01-15T14:30:00')
  })

  it('returns undefined for null/undefined', () => {
    expect(parseChoiceDate(null)).toBeUndefined()
    expect(parseChoiceDate(undefined)).toBeUndefined()
    expect(parseChoiceDate('')).toBeUndefined()
  })

  it('handles unparseable date gracefully', () => {
    const result = parseChoiceDate('not-a-date')
    expect(result).toBeUndefined()
  })
})

describe('normalizeChoiceWebhook', () => {
  describe('ESIM_ACTIVATED detection', () => {
    it('detects activation from threshold_code 1', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        message: 'First usage initiated',
        imsi: '310410123456789',
        iccid: '89012345678901234567',
        start_time: '2026-01-15-14.30.00',
        max_qty_type: 'MB',
        quantity_used: 10,
        maximum_units: 1024,
      })

      expect(result.providerType).toBe('CHOICE')
      expect(result.eventType).toBe('ESIM_ACTIVATED')
      expect(result.iccid).toBe('89012345678901234567')
      expect(result.imsi).toBe('310410123456789')
      expect(result.providerStatus).toBe('ACTIVE')
      expect(result.activatedAt).toContain('2026-01-15T14:30:00')
      expect(result.dataUsedMB).toBe(10)
      expect(result.dataTotalMB).toBe(1024)
      expect(result.dataRemainingMB).toBe(1014)
    })

    it('detects activation from initiated message', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 0,
        message: 'Usage initiated for device',
      })
      expect(result.eventType).toBe('ESIM_ACTIVATED')
    })

    it('detects activation from started message', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 0,
        message: 'Session started',
      })
      expect(result.eventType).toBe('ESIM_ACTIVATED')
    })
  })

  describe('ESIM_EXPIRED detection', () => {
    it('detects expired from threshold_code 7', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 7,
        message: 'Plan expired',
      })
      expect(result.eventType).toBe('ESIM_EXPIRED')
      expect(result.providerStatus).toBe('EXPIRED')
    })

    it('detects expired from expiry message', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 0,
        message: 'Bundle expiry reached',
      })
      expect(result.eventType).toBe('ESIM_EXPIRED')
    })
  })

  describe('USAGE_UPDATED detection', () => {
    it('detects usage from threshold_code 6', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 6,
        message: 'Data usage update',
      })
      expect(result.eventType).toBe('USAGE_UPDATED')
    })

    it('detects usage from depleted message', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 0,
        message: 'Data depleted',
      })
      expect(result.eventType).toBe('USAGE_UPDATED')
    })

    it('defaults to USAGE_UPDATED for unrecognized threshold_code', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 99,
        message: 'Some other notice',
      })
      expect(result.eventType).toBe('USAGE_UPDATED')
    })
  })

  describe('suspend/resume/topup/error detection', () => {
    it('detects suspended from message', () => {
      const result = normalizeChoiceWebhook({ command: '', message: 'eSIM has been suspended' })
      expect(result.eventType).toBe('ESIM_SUSPENDED')
    })

    it('detects resumed from message', () => {
      const result = normalizeChoiceWebhook({ command: '', message: 'eSIM has been resumed' })
      expect(result.eventType).toBe('ESIM_RESUMED')
    })

    it('detects topup from message', () => {
      const result = normalizeChoiceWebhook({ command: '', message: 'topup applied successfully' })
      expect(result.eventType).toBe('TOPUP_APPLIED')
    })

    it('detects error from message', () => {
      const result = normalizeChoiceWebhook({ command: '', message: 'Processing failed' })
      expect(result.eventType).toBe('PROVIDER_ERROR')
    })

    it('detects suspend from command', () => {
      const result = normalizeChoiceWebhook({ command: 'suspend_service', message: '' })
      expect(result.eventType).toBe('ESIM_SUSPENDED')
    })
  })

  describe('unit conversion', () => {
    it('converts GB to MB', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        max_qty_type: 'GB',
        quantity_used: 1,
        maximum_units: 5,
      })
      expect(result.dataUsedMB).toBe(1024)
      expect(result.dataTotalMB).toBe(5120)
    })

    it('converts TB to MB', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        max_qty_type: 'TB',
        quantity_used: 1,
        maximum_units: 1,
      })
      expect(result.dataUsedMB).toBe(1048576)
    })

    it('keeps MB as is', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        max_qty_type: 'MB',
        quantity_used: 500,
        maximum_units: 1000,
      })
      expect(result.dataUsedMB).toBe(500)
      expect(result.dataTotalMB).toBe(1000)
    })
  })

  describe('external event ID', () => {
    it('constructs external ID from all fields', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        iccid: '89012345678901234567',
        start_time: '2026-01-15-14.30.00',
        imsi_version: 'v2',
      })
      expect(result.externalEventId).toBe('choice:imsi_usage_threshold_notice:89012345678901234567:1:2026-01-15-14.30.00:v2')
    })

    it('uses imsi when iccid absent', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 1,
        imsi: '310410123456789',
      })
      expect(result.externalEventId).toContain(':310410123456789:')
    })
  })

  describe('missing fields', () => {
    it('handles minimal payload gracefully', () => {
      const result = normalizeChoiceWebhook({})
      expect(result.providerType).toBe('CHOICE')
      expect(result.eventType).toBe('UNKNOWN')
      expect(result.externalEventId).toBe('choice')
      expect(result.iccid).toBeUndefined()
      expect(result.dataUsedMB).toBeUndefined()
      expect(result.dataTotalMB).toBeUndefined()
    })
  })

  describe('expires_at field', () => {
    it('parses expire_time when present', () => {
      const result = normalizeChoiceWebhook({
        command: 'imsi_usage_threshold_notice',
        threshold_code: 7,
        expire_time: '2026-06-30-00.00.00',
      })
      expect(result.expiresAt).toContain('2026-06-30T00:00:00')
    })
  })
})
