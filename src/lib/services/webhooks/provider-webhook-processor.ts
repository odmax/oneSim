import { prisma } from '@/lib/prisma'
import { normalizeChoiceWebhook } from '@/lib/providers/webhooks/choice-webhook-normalizer'
import { deriveEsimLifecycleStatus } from '@/lib/services/esims/lifecycle-status'

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

const WEBHOOK_NORMALIZERS: Record<string, (payload: any) => NormalizedWebhookEvent> = {
  CHOICE: normalizeChoiceWebhook,
  IBASIS: normalizeIbasisWebhook,
}

import { normalizeIbasisWebhook } from '@/lib/providers/webhooks/ibasis-webhook-normalizer'

export function normalizeProviderWebhook(providerType: string, payload: any): NormalizedWebhookEvent {
  const normalizer = WEBHOOK_NORMALIZERS[providerType.toUpperCase()]
  if (normalizer) {
    return normalizer(payload)
  }
  return normalizeGeneric(payload, providerType)
}

/**
 * Maps a normalized lifecycle event to the provider-normalized canonical claim
 * that the shared lifecycle engine arbitrates. This is a CLAIM, not evidence:
 * ACTIVE still requires activation history / verified network attach / usage
 * evidence inside deriveEsimLifecycleStatus (rule 4). EXPIRED / SUSPENDED map
 * to their canonical states and inherit terminal/monotonic protection.
 */
export function webhookLifecycleClaim(eventType: NormalizedWebhookEvent['eventType']): string {
  switch (eventType) {
    case 'ESIM_EXPIRED':
      return 'EXPIRED'
    case 'ESIM_SUSPENDED':
      return 'SUSPENDED'
    case 'ESIM_RESUMED':
    case 'ESIM_ACTIVATED':
      return 'ACTIVE'
    default:
      return 'PENDING_ACTIVATION'
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
    const stored = event.payload as any
    const rawPayload = stored && typeof stored === 'object' && 'body' in stored ? stored.body : stored
    const normalized = normalizeProviderWebhook(event.providerType, rawPayload)

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
      // Lifecycle events are routed through the SHARED canonical engine
      // (deriveEsimLifecycleStatus) — exactly like polling/status sync. The
      // webhook processor never re-implements a provider state machine and
      // never directly forces ACTIVE/EXPIRED/SUSPENDED from the event NAME.
      // Terminal preservation (EXPIRED/FAILED/CANCELLED are one-way) and
      // monotonic protection come from the engine, so a stale/late/out-of-order
      // webhook cannot resurrect a terminal eSIM or downgrade a stronger state.
      case 'ESIM_ACTIVATED':
      case 'ESIM_EXPIRED':
      case 'ESIM_SUSPENDED':
      case 'ESIM_RESUMED': {
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId } })
        const claim = webhookLifecycleClaim(normalized.eventType)
        const lifecycle = deriveEsimLifecycleStatus({
          providerNormalizedStatus: claim,
          currentStatus: existing?.status || 'PENDING_ACTIVATION',
          dataUsedMB: (existing?.dataUsedMB || 0) || (normalized.dataUsedMB || 0),
          activatedAt: existing?.activatedAt ?? null,
        })
        const lifecycleWrite: any = {
          status: lifecycle.status,
          providerStatus: normalized.providerStatus || lifecycle.status,
          lastSyncAt: now,
          lastStatusSyncAt: now,
        }
        if (normalized.usageDate) lifecycleWrite.lastUsageAt = new Date(normalized.usageDate)
        if (normalized.eventType === 'ESIM_EXPIRED' && normalized.expiresAt) lifecycleWrite.expiresAt = new Date(normalized.expiresAt)
        // Activation history is only set when the engine authorizes it from
        // real evidence (usage/network/activation history) — never fabricated
        // from the event name or a raw timestamp.
        if (lifecycle.setActivatedAt && existing && !existing.activatedAt) {
          lifecycleWrite.activatedAt = normalized.activatedAt ? new Date(normalized.activatedAt) : now
          lifecycleWrite.activationDetectedAt = now
        }
        lifecycleWrite.providerResponse = {
          ...(existing?.providerResponse && typeof existing.providerResponse === 'object' ? existing.providerResponse as Record<string, unknown> : {}),
          webhook: normalized.eventType,
          rawStatus: normalized.providerStatus || claim,
          evidence: lifecycle.reason,
          evidenceObservedAt: now.toISOString(),
        }
        await prisma.eSIM.update({ where: { id: esimId }, data: lifecycleWrite })
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