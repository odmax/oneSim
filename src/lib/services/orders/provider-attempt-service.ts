import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { classifyRetry } from '@/lib/services/routing/provider-failover-engine'
import { completeProviderOperation, failProviderOperation } from '@/lib/services/jobs/provider-finalizer'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import type { ProviderScore } from '@/lib/services/routing/provider-routing-engine'

export type AttemptSource = 'PURCHASE' | 'POLLING' | 'WEBHOOK'
export type AttemptStatus = 'STARTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED'
export type ProviderPolicy = 'STRICT' | 'PREFERRED' | 'AUTO'

interface ActivationInput {
  orderId: string
  businessId: string
  providerId: string
  providerName: string
  planId: string
  quantity: number
  subscriber: { email: string; first_name?: string; last_name?: string }
  totalAmount: number
  displayName: string
  packageId: string
  packageSnapshot: any
  pkg: { id: string; dataGB: number; validityDays: number; currency: string }
  customerId?: string
  rankedProviders?: ProviderScore[]
  policy?: ProviderPolicy
  /** Travel date (YYYY-MM-DD) to forward to providers that require it. */
  travelDate?: string
}

export async function executeProviderAttempt(input: ActivationInput): Promise<{ success: boolean; status: string; errorCode?: string; errorMessage?: string; providerReference?: string; iccids?: string[]; qrCode?: string }> {
  const { orderId, businessId, providerId, providerName, planId, quantity, subscriber, totalAmount, displayName, packageId, packageSnapshot, pkg, customerId, rankedProviders, policy, travelDate } = input

  // Verify order not already terminal
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, include: { esims: true } })
  if (!order) return { success: false, status: 'ORDER_NOT_FOUND', errorCode: 'ORDER_NOT_FOUND' }
  if (order.status === 'FULFILLED' || order.esims.length > 0) return { success: true, status: 'ALREADY_COMPLETE' }

  // Count existing attempts from this source
  const existingAttempts = await prisma.providerAttempt.count({
    where: { orderId, source: 'PURCHASE' },
  })
  const attemptNumber = existingAttempts + 1

  // Check policy
  if (policy === 'STRICT' && existingAttempts > 0) {
    return { success: false, status: 'POLICY_VIOLATION', errorCode: 'STRICT_POLICY_NO_FAILOVER' }
  }

  if (attemptNumber > 3) {
    return { success: false, status: 'MAX_ATTEMPTS', errorCode: 'ALL_PROVIDERS_EXHAUSTED' }
  }

  // Record attempt start
  const startedAt = new Date()
  const attempt = await prisma.providerAttempt.create({
    data: {
      orderId, providerId, attemptNumber,
      source: 'PURCHASE', status: 'STARTED', startedAt,
    },
  })

  // Resolve adapter
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), errorCode: 'PROVIDER_NOT_FOUND' } })
    return { success: false, status: 'PROVIDER_NOT_FOUND' }
  }

  const adapter = await getAdapterForType(provider.type, {
    apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
    providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
  })

  // Validate config
  if (adapter.validatePurchase) {
    const v = await adapter.validatePurchase({ planId, quantity, subscriber })
    if (!v.valid) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), retryClassification: 'NON_RETRYABLE', errorCode: 'CONFIG_INVALID', errorMessage: v.reason } })
      return { success: false, status: 'CONFIG_INVALID', errorCode: 'PROVIDER_CONFIG', errorMessage: v.reason }
    }
  }

  // Dispatch
  try {
    const result = await adapter.activateESIM({ planId, quantity, subscriber, activationType: 'ACTIVATE_NOW', externalId: businessId, orderId, ...(travelDate ? { travelDate } : {}) } as any)
    const latencyMs = Date.now() - startedAt.getTime()

    if (!result.success || !result.data) {
      const err = result.error
      const classification = classifyRetry(err)
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', completedAt: new Date(), latencyMs, retryClassification: classification, errorCode: err?.code, errorMessage: err?.message, providerReference: (result.data as any)?.activationId },
      })
      return { success: false, status: classification === 'RETRYABLE' ? 'RETRYABLE' : 'FAILED', errorCode: err?.code, errorMessage: err?.message }
    }

    const data = result.data
    const providerOrderId = data.activationId || (data as any).providerOrderId || undefined
    // An operation is asynchronous when the provider reports a non-terminal waiting
    // status OR has not yet delivered a final ICCID. Broadened from the original
    // rule so providers (e.g. iBASIS) that pre-allocate an ICCID but return a
    // PENDING/PROCESSING status are correctly polled instead of finalized early.
    const AWAITING_STATUSES = ['PENDING', 'PROCESSING', 'QUEUED', 'PENDING_ACTIVATION', 'RESERVED', 'PROVISIONING']
    const isAwaitingActivation = data.status && AWAITING_STATUSES.includes(String(data.status).toUpperCase())
    const hasIccids = data.iccids && data.iccids.length > 0
    const isAsync = Boolean(isAwaitingActivation) || !hasIccids

    if (isAsync && providerOrderId) {
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: { status: 'PROCESSING', providerReference: providerOrderId, latencyMs },
      })
      // Create background job
      const { ProviderJobEngine } = await import('@/lib/services/jobs/provider-job-engine')
      await ProviderJobEngine.createJob({ orderId, businessId, providerId, providerRef: providerOrderId, totalAmount, operation: 'activation' })
      return { success: true, status: 'PROCESSING', providerReference: providerOrderId }
    }

    // Immediate success — extract ICCIDs and finalize
    const extractString = (raw: any): string | null => raw == null ? null : String(raw)
    const iccids: string[] = []
    for (let i = 0; i < quantity; i++) {
      iccids.push(extractString(data.iccids?.[i]) || extractString(data.imsis?.[i])?.replace(/[^0-9]/g, '') || '')
    }

    if (iccids.some(e => !e)) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', completedAt: new Date(), latencyMs, retryClassification: 'RETRYABLE', errorCode: 'INCOMPLETE_RESPONSE', errorMessage: 'No ICCID in response' } })
      return { success: false, status: 'RETRYABLE', errorCode: 'INCOMPLETE_RESPONSE' }
    }

    await completeProviderOperation({
      orderId, businessId, providerId, providerRef: providerOrderId || '', providerName: providerName || provider.name,
      totalAmount, iccids, userId: order.userId || undefined,
      packageSnapshot: order.packageSnapshot as any, packageName: order.packageName || '',
      packageDataGB: order.packageDataGB ?? undefined, packageValidityDays: order.packageValidityDays ?? undefined,
    })

    await prisma.providerAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', completedAt: new Date(), latencyMs, providerReference: providerOrderId },
    })

    return { success: true, status: 'SUCCEEDED', providerReference: providerOrderId, iccids, qrCode: extractString(data.qrCodeUrl) || undefined }
  } catch (e: any) {
    const classification = classifyRetry({ code: 'PROVIDER_ERROR', message: e.message })
    await prisma.providerAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', completedAt: new Date(), latencyMs: Date.now() - startedAt.getTime(), retryClassification: classification, errorCode: 'PROVIDER_ERROR', errorMessage: e.message?.substring(0, 500) },
    })
    return { success: false, status: classification === 'RETRYABLE' ? 'RETRYABLE' : 'FAILED', errorCode: 'PROVIDER_ERROR', errorMessage: e.message }
  }
}

export async function tryFailoverAfterAttempt(input: ActivationInput & { currentProviderId: string; attemptedIds: string[] }): Promise<{ shouldContinue: boolean; providerId?: string; providerName?: string } | null> {
  const { rankedProviders, attemptedIds, currentProviderId, policy } = input

  if (policy === 'STRICT') return null

  const next = (rankedProviders || []).find(p => !attemptedIds.includes(p.providerId) && p.providerId !== currentProviderId)
  if (!next) return null

  const provider = await prisma.provider.findUnique({ where: { id: next.providerId } })
  if (!provider || !['ACTIVE', 'DEGRADED', 'TESTING'].includes(provider.status)) return null

  await createTimelineEvent(input.orderId, { eventType: 'PROVIDER_FAILOVER', message: `Failover: → ${next.providerName} (${next.providerId})` })

  return { shouldContinue: true, providerId: next.providerId, providerName: next.providerName }
}
