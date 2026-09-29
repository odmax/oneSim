import { prisma } from '@/lib/prisma'
import { normalizeChoiceWebhook } from '@/lib/providers/webhooks/choice-webhook-normalizer'
import { normalizeTelnaWebhook } from '@/lib/providers/webhooks/telna-webhook-normalizer'
import { deriveEsimLifecycleStatus, deriveDepletionStatus, deriveUsageActivation, isProviderExhaustedStatus } from '@/lib/services/esims/lifecycle-status'

export interface NormalizedWebhookEvent {
  providerType: string
  eventType: 'ESIM_ACTIVATED' | 'ESIM_INSTALLED' | 'ESIM_PROFILE_DOWNLOADED' | 'ESIM_PROFILE_DISABLED' | 'ESIM_PROFILE_DELETED' | 'ESIM_INSTALLATION_FAILED' | 'USAGE_UPDATED' | 'ESIM_EXPIRED' | 'ESIM_SUSPENDED' | 'ESIM_RESUMED' | 'TOPUP_APPLIED' | 'PROVIDER_ERROR' | 'UNKNOWN'
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
  installationStatus?: string
  raw?: any
}

const WEBHOOK_NORMALIZERS: Record<string, (payload: any) => NormalizedWebhookEvent> = {
  CHOICE: normalizeChoiceWebhook,
  IBASIS: normalizeIbasisWebhook,
  TELNA: normalizeTelnaWebhook,
}

import { normalizeIbasisWebhook } from '@/lib/providers/webhooks/ibasis-webhook-normalizer'

export function normalizeProviderWebhook(providerType: string, payload: any): NormalizedWebhookEvent {
  const normalizer = WEBHOOK_NORMALIZERS[providerType.toUpperCase()]
  if (normalizer) {
    const normalized = normalizer(payload)
    // Keep compatibility with older generic Telna callbacks while preferring
    // the documented RSP / package payload shapes whenever they are present.
    if (providerType.toUpperCase() === 'TELNA' && normalized.eventType === 'UNKNOWN' && (payload?.event || payload?.type)) {
      return normalizeGeneric(payload, providerType)
    }
    return normalized
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
  // Nullish access preserves a legitimate numeric zero; a genuinely missing
  // value stays undefined (unknown) and is never mistaken for a real zero.
  const dataUsedMB = payload.dataUsedMB ?? usage.usedMB ?? undefined
  const dataTotalMB = payload.dataTotalMB ?? usage.totalMB ?? undefined
  const dataRemainingMB = payload.dataRemainingMB ?? usage.remainingMB ?? undefined

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

export async function processProviderWebhookEvent(eventId: string, claimed = false): Promise<{ success: boolean; status: string; error?: string }> {
  const event = await prisma.providerWebhookEvent.findUnique({ where: { id: eventId } })
  if (!event) return { success: false, status: 'FAILED', error: 'Event not found' }

  if ((event.status === 'RECEIVED' || event.status === 'FAILED') && !claimed) {
    const claim = await prisma.providerWebhookEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: 'PROCESSING', errorMessage: null, processedAt: null },
    })
    if (claim.count !== 1) return { success: true, status: 'PROCESSING' }
  } else if (event.status === 'PROCESSING' && !claimed) {
    return { success: true, status: 'PROCESSING' }
  } else if (event.status !== 'RECEIVED' && event.status !== 'PROCESSING' && !(claimed && event.status === 'FAILED')) {
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

      const providerOwnership = event.providerId
        ? {
            OR: [
              { purchase: { providerId: event.providerId } },
              { purchase: { package: { providerId: event.providerId } } },
            ],
          }
        : {}
      const telnaProviderMissing = event.providerType.toUpperCase() === 'TELNA' && !event.providerId
      const esim = where.length > 0 && !telnaProviderMissing
        ? await prisma.eSIM.findFirst({
            where: { AND: [{ OR: where }, providerOwnership] },
            include: { purchase: { select: { businessId: true, providerId: true, package: { select: { providerId: true } } } } },
          })
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

      case 'ESIM_INSTALLED':
      case 'ESIM_PROFILE_DISABLED': {
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId } })
        const lifecycle = deriveEsimLifecycleStatus({
          providerNormalizedStatus: 'INSTALLED',
          currentStatus: existing?.status || 'PENDING_ACTIVATION',
          dataUsedMB: existing?.dataUsedMB || 0,
          activatedAt: existing?.activatedAt ?? null,
          providerInstalledSignal: true,
        })
        const write: any = {
          installationStatus: normalized.installationStatus || (normalized.eventType === 'ESIM_PROFILE_DISABLED' ? 'DISABLED' : 'INSTALLED'),
          installationLastCheckedAt: now,
          installationLastError: null,
          lastSyncAt: now,
          lastStatusSyncAt: now,
          providerStatus: normalized.providerStatus || existing?.providerStatus,
          providerResponse: {
            ...(existing?.providerResponse && typeof existing.providerResponse === 'object' ? existing.providerResponse as Record<string, unknown> : {}),
            telnaInstallationEvent: normalized.eventType,
            evidence: lifecycle.reason,
            evidenceObservedAt: now.toISOString(),
          },
        }
        if (lifecycle.status !== existing?.status) write.status = lifecycle.status
        await prisma.eSIM.update({ where: { id: esimId }, data: write })
        break
      }

      case 'ESIM_PROFILE_DOWNLOADED':
      case 'ESIM_INSTALLATION_FAILED': {
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId } })
        await prisma.eSIM.update({
          where: { id: esimId },
          data: {
            installationStatus: normalized.installationStatus || (normalized.eventType === 'ESIM_INSTALLATION_FAILED' ? 'FAILED' : 'DOWNLOADED'),
            installationLastCheckedAt: now,
            installationLastError: normalized.eventType === 'ESIM_INSTALLATION_FAILED' ? 'Telna reported an eSIM profile download or installation failure' : null,
            providerStatus: normalized.providerStatus || existing?.providerStatus,
            providerResponse: {
              ...(existing?.providerResponse && typeof existing.providerResponse === 'object' ? existing.providerResponse as Record<string, unknown> : {}),
              telnaInstallationEvent: normalized.eventType,
              evidenceObservedAt: now.toISOString(),
            },
          },
        })
        break
      }

      case 'ESIM_PROFILE_DELETED': {
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId } })
        const lifecycle = deriveEsimLifecycleStatus({
          providerNormalizedStatus: 'PENDING_ACTIVATION',
          currentStatus: existing?.status || 'PENDING_ACTIVATION',
          dataUsedMB: existing?.dataUsedMB || 0,
          activatedAt: existing?.activatedAt ?? null,
          providerProfileDeletedSignal: true,
        })
        const write: any = {
          installationStatus: 'DELETED',
          installationLastCheckedAt: now,
          installationLastError: null,
          lastSyncAt: now,
          lastStatusSyncAt: now,
          providerStatus: normalized.providerStatus || existing?.providerStatus,
          providerResponse: {
            ...(existing?.providerResponse && typeof existing.providerResponse === 'object' ? existing.providerResponse as Record<string, unknown> : {}),
            telnaInstallationEvent: normalized.eventType,
            evidence: lifecycle.reason,
            evidenceObservedAt: now.toISOString(),
          },
        }
        if (lifecycle.status !== existing?.status) write.status = lifecycle.status
        await prisma.eSIM.update({ where: { id: esimId }, data: write })
        break
      }

      case 'USAGE_UPDATED': {
        const usageData: any = { lastSyncAt: now, lastStatusSyncAt: now, lastUsageSyncAt: now, lastUsageAt: now }
        if (normalized.dataUsedMB != null) usageData.dataUsedMB = normalized.dataUsedMB
        if (normalized.dataTotalMB != null) usageData.dataTotalMB = normalized.dataTotalMB
        if (normalized.dataRemainingMB != null) usageData.dataRemainingMB = normalized.dataRemainingMB
        if (normalized.usageDate) usageData.lastUsageAt = new Date(normalized.usageDate)

        // A webhook reporting authoritative remaining zero is capable of deriving
        // DEPLETED (same canonical engine as scheduled/manual sync). Missing or
        // unknown remaining never implies depletion; terminal states are never
        // rewritten.
        const existing = await prisma.eSIM.findUnique({ where: { id: esimId }, select: { status: true, providerStatus: true, activatedAt: true } })
        const providerStatusRaw = String(normalized.providerStatus || '')
        const remainingNum =
          normalized.dataRemainingMB != null && Number.isFinite(Number(normalized.dataRemainingMB))
            ? Number(normalized.dataRemainingMB)
            : undefined
        const depletion = deriveDepletionStatus(existing?.status || 'PENDING_ACTIVATION', {
          dataRemainingMB: remainingNum,
          snapshotValid: remainingNum != null,
          providerExhausted: isProviderExhaustedStatus(providerStatusRaw || undefined),
        })
        // Canonical PENDING → ACTIVE promotion from authoritative usage evidence
        // (identical to scheduled/manual usage sync). A positive used value is
        // activation evidence; zero/missing is not.
        const activation = deriveUsageActivation({
          currentStatus: existing?.status || 'PENDING_ACTIVATION',
          dataUsedMB: normalized.dataUsedMB == null ? undefined : Number(normalized.dataUsedMB),
          activatedAt: existing?.activatedAt ?? null,
        })
        const targetStatus = depletion || (activation.status !== (existing?.status || 'PENDING_ACTIVATION') ? activation.status : existing?.status || 'PENDING_ACTIVATION')
        if (targetStatus !== (existing?.status || 'PENDING_ACTIVATION')) usageData.status = targetStatus
        if (targetStatus === 'ACTIVE' && activation.setActivatedAt && existing && !existing.activatedAt) {
          usageData.activatedAt = normalized.activatedAt ? new Date(normalized.activatedAt) : new Date()
          usageData.activationDetectedAt = new Date()
        }
        if (providerStatusRaw && existing?.providerStatus !== providerStatusRaw) usageData.providerStatus = providerStatusRaw

        await prisma.eSIM.update({ where: { id: esimId }, data: usageData })

        // History record only when an authoritative value exists; a real zero is
        // preserved and a missing value is never fabricated as 0.
        if (normalized.dataUsedMB != null || normalized.dataTotalMB != null || normalized.dataRemainingMB != null) {
          await prisma.usageRecord.create({
            data: {
              esimId,
              dataUsedMB: normalized.dataUsedMB ?? 0,
              dataTotalMB: normalized.dataTotalMB ?? null,
              dataRemainingMB: normalized.dataRemainingMB ?? null,
              timestamp: normalized.usageDate ? new Date(normalized.usageDate) : now,
            },
          })
        }
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

      case 'PROVIDER_ERROR': {
        // A provider-declared failure is NOT an authoritative canonical status:
        // it may be transient and the eSIM row can hold stronger evidence. Never
        // write FAILED from the event name — record the event as IGNORED with a
        // durable reason and preserve the canonical status unchanged.
        updateData.status = 'IGNORED'
        updateData.errorMessage = 'Provider error event — canonical eSIM status preserved'
        break
      }

      default: {
        updateData.status = 'IGNORED'
        updateData.errorMessage = 'Unrecognized event type'
        break
      }
    }

    const finalStatus = updateData.status || 'PROCESSED'
    await prisma.providerWebhookEvent.update({
      where: { id: eventId },
      data: { ...updateData, status: finalStatus, processedAt: now, esimId, businessId },
    })

    return { success: true, status: finalStatus }
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
      // Do not process an in-flight delivery twice: parallel callbacks can
      // otherwise duplicate usage history writes. FAILED/RECEIVED rows are
      // atomically claimed before their retry is processed.
      if (existing.status === 'PROCESSING') {
        return { success: true, duplicate: true, status: existing.status, eventId: existing.id }
      }
      if (existing.status === 'RECEIVED' || existing.status === 'FAILED') {
        const claimed = await prisma.providerWebhookEvent.updateMany({
          where: { id: existing.id, status: existing.status },
          data: { status: 'PROCESSING', errorMessage: null, processedAt: null },
        })
        if (claimed.count !== 1) {
          return { success: true, duplicate: true, status: 'PROCESSING', eventId: existing.id }
        }
        const result = await processProviderWebhookEvent(existing.id, true)
        return { success: result.success, status: result.status, eventId: existing.id, error: result.error }
      }
    }
  }

  // Persist the provider association (when resolvable by code) so provider-scoped
  // operational alerts (e.g. WEBHOOK_BACKLOG) can measure this provider's events.
  let providerId: string | null = null
  try {
    const provider = await prisma.provider.findFirst({ where: { code: providerType.toUpperCase() }, select: { id: true } })
    providerId = provider?.id || null
  } catch {}

  const event = await prisma.providerWebhookEvent.create({
    data: {
      providerType: providerType.toUpperCase(),
      providerId,
      eventType: normalized.eventType,
      externalEventId: normalized.externalEventId || null,
      iccid: normalized.iccid || null,
      imsi: normalized.imsi || null,
      status: 'PROCESSING',
      payload: payload as any,
    },
  })

  const result = await processProviderWebhookEvent(event.id, true)

  return {
    success: result.success,
    status: result.status,
    eventId: event.id,
    error: result.error,
  }
}
