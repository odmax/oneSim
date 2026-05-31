import { prisma } from '@/lib/prisma'

export interface NormalizedWebhookEvent {
  providerType: string
  eventType: 'ESIM_ACTIVATED' | 'USAGE_UPDATED' | 'ESIM_EXPIRED' | 'ESIM_SUSPENDED' | 'ESIM_RESUMED' | 'TOPUP_APPLIED' | 'PROVIDER_ERROR' | 'UNKNOWN'
  externalEventId?: string
  iccid?: string
  imsi?: string
  providerStatus?: string
  activatedAt?: string
  usageDate?: string
  dataUsedMB?: number
  dataTotalMB?: number
  dataRemainingMB?: number
  expiresAt?: string
  raw?: any
}

export function normalizeProviderWebhook(providerType: string, payload: any): NormalizedWebhookEvent {
  if (providerType === 'CHOICE' || providerType === 'choice') {
    return normalizeChoice(payload)
  }
  return normalizeGeneric(payload, providerType)
}

function parseChoiceDate(dateStr: string | undefined | null): string | undefined {
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

function normalizeChoice(payload: any): NormalizedWebhookEvent {
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

function normalizeGeneric(payload: any, providerType: string): NormalizedWebhookEvent {
  const event = payload.event || payload.type || ''
  const eLower = String(event).toLowerCase()

  let eventType: NormalizedWebhookEvent['eventType'] = 'UNKNOWN'
  if (eLower.includes('active') || eLower.includes('activated') || eLower === 'in_use') eventType = 'ESIM_ACTIVATED'
  else if (eLower.includes('usage') || eLower === 'usage.updated') eventType = 'USAGE_UPDATED'
  else if (eLower.includes('expired')) eventType = 'ESIM_EXPIRED'
  else if (eLower.includes('suspend')) eventType = 'ESIM_SUSPENDED'
  else if (eLower.includes('resume')) eventType = 'ESIM_RESUMED'
  else if (eLower.includes('topup') || eLower.includes('top_up')) eventType = 'TOPUP_APPLIED'
  else if (eLower.includes('error') || eLower.includes('fail')) eventType = 'PROVIDER_ERROR'

  const usage = payload.usage || payload.usageData || {}
  const dataUsedMB = payload.dataUsedMB || usage.usedMB || undefined
  const dataTotalMB = payload.dataTotalMB || usage.totalMB || undefined
  const dataRemainingMB = payload.dataRemainingMB || usage.remainingMB || undefined

  const externalId = `${providerType}:${event}:${payload.iccid || payload.imsi || ''}:${payload.timestamp || ''}`

  return {
    providerType: providerType.toUpperCase(),
    eventType,
    externalEventId: externalId,
    iccid: payload.iccid ? String(payload.iccid) : undefined,
    imsi: payload.imsi ? String(payload.imsi) : undefined,
    providerStatus: payload.status || undefined,
    activatedAt: payload.activatedAt || payload.activated_at || undefined,
    usageDate: payload.usageDate || payload.usage_date || payload.timestamp || undefined,
    dataUsedMB,
    dataTotalMB,
    dataRemainingMB,
    expiresAt: payload.expiresAt || payload.expires_at || undefined,
    raw: payload,
  }
}

export async function processProviderWebhookEvent(eventId: string): Promise<{ success: boolean; status: string; error?: string }> {
  const event = await prisma.providerWebhookEvent.findUnique({ where: { id: eventId } })
  if (!event) return { success: false, status: 'FAILED', error: 'Event not found' }

  if (event.status !== 'RECEIVED') {
    return { success: true, status: event.status }
  }

  try {
    const normalized = normalizeProviderWebhook(event.providerType, event.payload as any)

    let esimId = event.esimId
    let businessId = event.businessId

    if (!esimId) {
      const where: any[] = []
      if (normalized.iccid) where.push({ iccid: normalized.iccid })
      if (normalized.imsi) where.push({ imsi: normalized.imsi })

      const esim = where.length > 0
        ? await prisma.eSIM.findFirst({ where: { OR: where }, include: { purchase: { select: { businessId: true } } } })
        : null

      if (!esim) {
        await prisma.providerWebhookEvent.update({
          where: { id: eventId },
          data: { status: 'IGNORED', errorMessage: 'No matching eSIM found', processedAt: new Date() },
        })
        return { success: true, status: 'IGNORED' }
      }

      esimId = esim.id
      businessId = esim.purchase.businessId
    }

    const updateData: any = { esimId, businessId }
    const now = new Date()

    switch (normalized.eventType) {
      case 'ESIM_ACTIVATED': {
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId } })
        const activatedAt = normalized.activatedAt ? new Date(normalized.activatedAt) : (existing?.activatedAt || now)

        await prisma.eSIM.update({
          where: { id: esimId },
          data: {
            status: 'ACTIVE',
            providerStatus: normalized.providerStatus || 'ACTIVE',
            activatedAt,
            ...(existing && !existing.activationDetectedAt ? { activationDetectedAt: now } : {}),
            lastUsageAt: normalized.usageDate ? new Date(normalized.usageDate) : now,
            lastSyncAt: now,
            lastStatusSyncAt: now,
          },
        })
        break
      }

      case 'USAGE_UPDATED': {
        const usageData: any = { lastSyncAt: now, lastStatusSyncAt: now }
        if (normalized.dataUsedMB != null) usageData.dataUsedMB = normalized.dataUsedMB
        if (normalized.dataTotalMB != null) usageData.dataTotalMB = normalized.dataTotalMB
        if (normalized.dataRemainingMB != null) usageData.dataRemainingMB = normalized.dataRemainingMB
        if (normalized.usageDate) usageData.lastUsageAt = new Date(normalized.usageDate)
        await prisma.eSIM.update({ where: { id: esimId }, data: usageData })

        await prisma.usageRecord.create({
          data: {
            esimId,
            dataUsedMB: normalized.dataUsedMB || 0,
            dataTotalMB: normalized.dataTotalMB || null,
            dataRemainingMB: normalized.dataRemainingMB || null,
            timestamp: normalized.usageDate ? new Date(normalized.usageDate) : now,
          },
        })
        break
      }

      case 'ESIM_EXPIRED': {
        const expData: any = { status: 'EXPIRED', providerStatus: 'EXPIRED', lastSyncAt: now, lastStatusSyncAt: now }
        if (normalized.expiresAt) expData.expiresAt = new Date(normalized.expiresAt)
        await prisma.eSIM.update({ where: { id: esimId }, data: expData })
        break
      }

      case 'ESIM_SUSPENDED': {
        await prisma.eSIM.update({ where: { id: esimId }, data: { status: 'SUSPENDED', providerStatus: 'SUSPENDED', lastSyncAt: now, lastStatusSyncAt: now } })
        break
      }

      case 'ESIM_RESUMED': {
        await prisma.eSIM.update({ where: { id: esimId }, data: { status: 'ACTIVE', providerStatus: 'ACTIVE', lastSyncAt: now, lastStatusSyncAt: now } })
        break
      }

      case 'TOPUP_APPLIED': {
        const topData: any = { lastSyncAt: now, lastStatusSyncAt: now }
        if (normalized.dataTotalMB != null) topData.dataTotalMB = normalized.dataTotalMB
        if (normalized.dataRemainingMB != null) topData.dataRemainingMB = normalized.dataRemainingMB
        if (normalized.expiresAt) topData.expiresAt = new Date(normalized.expiresAt)
        await prisma.eSIM.update({ where: { id: esimId }, data: topData })
        break
      }

      default: {
        updateData.status = 'IGNORED'
        updateData.errorMessage = 'Unrecognized event type'
        break
      }
    }

    await prisma.providerWebhookEvent.update({
      where: { id: eventId },
      data: { ...updateData, status: 'PROCESSED', processedAt: now, esimId, businessId },
    })

    return { success: true, status: 'PROCESSED' }
  } catch (error: any) {
    await prisma.providerWebhookEvent.update({
      where: { id: eventId },
      data: { status: 'FAILED', errorMessage: error.message || 'Processing error', processedAt: new Date() },
    })
    return { success: false, status: 'FAILED', error: error.message }
  }
}

export async function receiveProviderWebhook(providerType: string, payload: any): Promise<{ success: boolean; status: string; eventId?: string; duplicate?: boolean; error?: string }> {
  const normalized = normalizeProviderWebhook(providerType, payload)

  if (normalized.externalEventId) {
    const existing = await prisma.providerWebhookEvent.findUnique({
      where: { providerType_externalEventId: { providerType: providerType.toUpperCase(), externalEventId: normalized.externalEventId } },
    })
    if (existing) {
      if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
        return { success: true, duplicate: true, status: existing.status }
      }
    }
  }

  const event = await prisma.providerWebhookEvent.create({
    data: {
      providerType: providerType.toUpperCase(),
      eventType: normalized.eventType,
      externalEventId: normalized.externalEventId || null,
      iccid: normalized.iccid || null,
      imsi: normalized.imsi || null,
      status: 'RECEIVED',
      payload: payload as any,
    },
  })

  const result = await processProviderWebhookEvent(event.id)

  return {
    success: result.success,
    status: result.status,
    eventId: event.id,
    error: result.error,
  }
}