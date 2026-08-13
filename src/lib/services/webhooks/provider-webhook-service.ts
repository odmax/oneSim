import { prisma } from '@/lib/prisma'
import { completeProviderOperation, failProviderOperation } from '@/lib/services/jobs/provider-finalizer'

export interface NormalizedWebhookEvent {
  eventId?: string
  eventType: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  providerReference?: string
  orderReference?: string
  iccids?: string[]
  qrCode?: string
  activationCode?: string
  errorCode?: string
  errorMessage?: string
  raw?: unknown
}

export async function processProviderWebhook(providerId: string, event: NormalizedWebhookEvent): Promise<{ success: boolean; status: string; matched: boolean }> {
  // Replay protection: check event fingerprint
  const fingerprint = await buildFingerprint(providerId, event)
  if (fingerprint) {
    const existing = await findDuplicateEvent(providerId, fingerprint)
    if (existing) return { success: true, status: 'DUPLICATE', matched: false }
  }

  // Find matching job or order
  const match = await findMatchingJob(providerId, event)
  if (!match) {
    await recordEvent(providerId, event, { success: true, status: 'NO_MATCH', matched: false }, fingerprint)
    return { success: true, status: 'NO_MATCH', matched: false }
  }

  const { orderId, businessId, providerRef, totalAmount, providerName, provider } = match

  // Check job eligibility
  if (['FULFILLED', 'CANCELLED', 'REFUNDED'].includes(match.orderStatus || '')) {
    await recordEvent(providerId, event, { success: true, status: 'ALREADY_TERMINAL', matched: true }, fingerprint)
    return { success: true, status: 'ALREADY_TERMINAL', matched: true }
  }

  try {
    if (event.status === 'COMPLETED') {
      await completeProviderOperation({
        orderId, businessId, providerId: provider.id,
        providerRef: providerRef || event.providerReference || '',
        providerName: providerName || provider.name,
        totalAmount, userId: match.userId || undefined,
        iccids: event.iccids || [],
        qrCodeUrl: event.qrCode || undefined,
        activationCode: event.activationCode || undefined,
        packageSnapshot: (match.packageSnapshot as any) ?? undefined,
        packageName: match.packageName || undefined,
        packageDataGB: (match.packageDataGB ?? undefined) as number | undefined,
        packageValidityDays: (match.packageValidityDays ?? undefined) as number | undefined,
      })
      // Cancel any pending background jobs for this order
      await prisma.backgroundJob.updateMany({
        where: { type: 'PROVIDER_OPERATION' as any, status: 'PENDING' as any, payload: { path: ['orderId'], equals: orderId } },
        data: { status: 'FAILED' as any, lastError: 'Completed via webhook' },
      })
      await recordEvent(providerId, event, { success: true, status: 'COMPLETED', matched: true }, fingerprint)
      return { success: true, status: 'COMPLETED', matched: true }
    }

    if (event.status === 'FAILED' || event.status === 'CANCELLED') {
      await failProviderOperation({
        orderId, businessId, providerId: provider.id,
        providerRef: providerRef || event.providerReference || '',
        totalAmount, reason: event.errorMessage || `Webhook ${event.status}`,
        userId: match.userId || undefined,
      })
      await prisma.backgroundJob.updateMany({
        where: { type: 'PROVIDER_OPERATION' as any, status: 'PENDING' as any, payload: { path: ['orderId'], equals: orderId } },
        data: { status: 'FAILED' as any, lastError: `Webhook ${event.status}` },
      })
      await recordEvent(providerId, event, { success: true, status: 'FAILED', matched: true }, fingerprint)
      return { success: true, status: 'FAILED', matched: true }
    }

    await recordEvent(providerId, event, { success: true, status: 'PROCESSING', matched: true }, fingerprint)
    return { success: true, status: 'PROCESSING', matched: true }
  } catch (error: any) {
    await recordEvent(providerId, event, { success: false, status: 'ERROR', matched: true, error: error.message }, fingerprint)
    return { success: false, status: 'ERROR', matched: true }
  }
}

async function findMatchingJob(providerId: string, event: NormalizedWebhookEvent) {
  // Try provider reference first
  if (event.providerReference) {
    const order = await prisma.eSIMPurchase.findFirst({
      where: { providerReservationId: event.providerReference, providerId },
      orderBy: { createdAt: 'desc' },
    })
    if (order) return mapOrderMatch(order)
  }

  // Try order reference
  if (event.orderReference) {
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: event.orderReference },
    })
    if (order && order.providerId === providerId) return mapOrderMatch(order)
  }

  // Try matching by provider ID on any recent order
  if (event.iccids?.length) {
    const esim = await prisma.eSIM.findFirst({
      where: { iccid: { in: event.iccids } },
      include: { purchase: true },
      orderBy: { createdAt: 'desc' },
    })
    if (esim?.purchase && esim.purchase.providerId === providerId) {
      return mapOrderMatch(esim.purchase)
    }
  }

  return null
}

function mapOrderMatch(order: any) {
  return {
    orderId: order.id,
    businessId: order.businessId,
    providerRef: order.providerReservationId || order.providerFulfillId || '',
    totalAmount: Number(order.totalAmount),
    orderStatus: order.status,
    userId: order.userId || '',
    providerName: order.providerName || '',
    provider: { id: order.providerId || '', name: order.providerName || '' },
    packageSnapshot: order.packageSnapshot,
    packageName: order.packageName,
    packageDataGB: order.packageDataGB,
    packageValidityDays: order.packageValidityDays,
  }
}

async function buildFingerprint(providerId: string, event: NormalizedWebhookEvent): Promise<string | null> {
  const parts = [providerId, event.eventId, event.providerReference, event.orderReference, event.eventType, event.status].filter(Boolean)
  if (parts.length < 2) return null
  return `wh:${parts.join(':')}`
}

async function findDuplicateEvent(providerId: string, fingerprint: string): Promise<boolean> {
  // Check provider config for recent webhook events
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
  if (!provider?.config) return false
  const cfg = provider.config as any
  const history: any[] = cfg.webhookHistory || []
  return history.some((h: any) => h.fingerprint === fingerprint && h.status === 'COMPLETED' && Date.now() - new Date(h.receivedAt).getTime() < 7 * 86400000)
}

async function recordEvent(providerId: string, event: NormalizedWebhookEvent, result: { success: boolean; status: string; matched: boolean; error?: string }, fingerprint: string | null) {
  try {
    const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
    const cfg = (provider?.config && typeof provider.config === 'object') ? { ...(provider.config as any) } : {}
    const history: any[] = (cfg.webhookHistory || []).slice(-99)
    history.push({
      fingerprint: fingerprint || '',
      eventType: event.eventType,
      status: event.status,
      providerReference: event.providerReference,
      result: result.status,
      receivedAt: new Date().toISOString(),
    })
    cfg.webhookHistory = history
    await prisma.provider.update({ where: { id: providerId }, data: { config: cfg } }).catch(() => {})
  } catch {}
}
