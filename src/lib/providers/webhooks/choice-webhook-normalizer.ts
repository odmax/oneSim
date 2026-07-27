import type { NormalizedWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'

export function parseChoiceDate(dateStr: string | undefined | null): string | undefined {
  if (!dateStr) return undefined
  try {
    const cleaned = dateStr.replace(/-/g, '/').replace(/\.(\d{6})$/, ':$1')
    const d = new Date(cleaned)
    if (!isNaN(d.getTime())) return d.toISOString()
    const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/)
    if (parts) {
      const [_, y, m, day, h, min, s] = parts
      const d2 = new Date(`${y}-${m}-${day}T${h}:${min}:${s}Z`)
      if (!isNaN(d2.getTime())) return d2.toISOString()
    }
  } catch { }
  return undefined
}

export function normalizeChoiceWebhook(payload: any): NormalizedWebhookEvent {
  const command = payload.command || ''
  const thresholdCode = String(payload.threshold_code || '')
  const msg = (payload.message || '').toLowerCase()

  let eventType: NormalizedWebhookEvent['eventType'] = 'UNKNOWN'

  if (command === 'imsi_usage_threshold_notice') {
    if (thresholdCode === '1' || msg.includes('initiated') || msg.includes('started') || msg.includes('first usage')) {
      eventType = 'ESIM_ACTIVATED'
    } else if (thresholdCode === '7' || msg.includes('expired') || msg.includes('expiry')) {
      eventType = 'ESIM_EXPIRED'
    } else if (thresholdCode === '6' || msg.includes('depleted') || msg.includes('exhausted')) {
      eventType = 'USAGE_UPDATED'
    } else {
      eventType = 'USAGE_UPDATED'
    }
  } else if (msg.includes('suspended') || command.includes('suspend')) {
    eventType = 'ESIM_SUSPENDED'
  } else if (msg.includes('resumed') || command.includes('resume')) {
    eventType = 'ESIM_RESUMED'
  } else if (msg.includes('topup') || msg.includes('top_up') || command.includes('topup')) {
    eventType = 'TOPUP_APPLIED'
  } else if (msg.includes('error') || msg.includes('fail')) {
    eventType = 'PROVIDER_ERROR'
  }

  const rawImsi = payload.imsi != null ? String(payload.imsi) : undefined
  const rawIccid = payload.iccid ? String(payload.iccid) : undefined
  const maxQtyType = (payload.max_qty_type || 'MB').toUpperCase()
  const quantityUsed = parseInt(payload.quantity_used) || 0
  const maximumUnits = parseInt(payload.maximum_units) || 0

  let dataUsedMB = quantityUsed
  if (maxQtyType === 'GB') dataUsedMB = quantityUsed * 1024
  if (maxQtyType === 'TB') dataUsedMB = quantityUsed * 1024 * 1024

  let dataTotalMB = maximumUnits
  if (maxQtyType === 'GB') dataTotalMB = maximumUnits * 1024
  if (maxQtyType === 'TB') dataTotalMB = maximumUnits * 1024 * 1024

  const externalId = [
    'choice',
    command,
    rawIccid || rawImsi || '',
    thresholdCode,
    payload.start_time || '',
    payload.imsi_version || '',
  ].filter(Boolean).join(':')

  return {
    providerType: 'CHOICE',
    eventType,
    externalEventId: externalId,
    iccid: rawIccid,
    imsi: rawImsi,
    providerStatus: eventType === 'ESIM_ACTIVATED' ? 'ACTIVE' : eventType === 'ESIM_EXPIRED' ? 'EXPIRED' : undefined,
    activatedAt: eventType === 'ESIM_ACTIVATED' ? parseChoiceDate(payload.start_time) : undefined,
    usageDate: parseChoiceDate(payload.start_time),
    dataUsedMB: dataUsedMB || undefined,
    dataTotalMB: dataTotalMB || undefined,
    dataRemainingMB: dataTotalMB > 0 && dataUsedMB > 0 ? Math.max(0, dataTotalMB - dataUsedMB) : undefined,
    expiresAt: parseChoiceDate(payload.expire_time),
    raw: payload,
  }
}
