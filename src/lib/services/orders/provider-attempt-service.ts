import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { classifyRetry, classifyProviderOutcome } from '@/lib/services/routing/provider-failover-engine'
import { completeProviderOperation, failProviderOperation } from '@/lib/services/jobs/provider-finalizer'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { normalizeConnectorInstallData } from '@/lib/esim/installation-data'
import type { ProviderScore } from '@/lib/services/routing/provider-routing-engine'
import { allocateProviderAttemptNumber } from './provider-attempt-number'

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
  /**
   * The canonical ProviderPackage.id the retail package is bound to. When
   * present, the execution boundary verifies this ProviderPackage belongs to
   * `providerId` and derives the external provider plan id from it — a provider
   * can never receive another provider's package identifier.
   */
  providerPackageId?: string
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
  const purchaseAttemptNumber = existingAttempts + 1

  // Check policy
  if (policy === 'STRICT' && existingAttempts > 0) {
    return { success: false, status: 'POLICY_VIOLATION', errorCode: 'STRICT_POLICY_NO_FAILOVER' }
  }

  if (purchaseAttemptNumber > 3) {
    return { success: false, status: 'MAX_ATTEMPTS', errorCode: 'ALL_PROVIDERS_EXHAUSTED' }
  }

  // Record attempt start. attemptNumber is globally monotonic PER ORDER across
  // all sources (PURCHASE/RECONCILIATION/…) so it stays unambiguous for
  // ordering consumers; the purchase-attempt guard above keeps its own
  // PURCHASE-scoped count semantics.
  const startedAt = new Date()
  const attempt = await prisma.providerAttempt.create({
    data: {
      orderId, providerId, attemptNumber: await allocateProviderAttemptNumber(orderId),
      source: 'PURCHASE', status: 'STARTED', startedAt,
      metadata: {
        providerPackageId: input.providerPackageId || null,
        externalPlanId: planId,
        retailPackageId: packageId,
      } as any,
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

  // ── Execution-boundary ownership guard (provider-neutral) ────────────────
  // A retail package is bound to exactly one ProviderPackage (providerPackageId).
  // A provider attempt may only execute when the selected provider OWNS that
  // ProviderPackage, and the external plan id must be derived FROM that
  // ProviderPackage — never carried forward from another provider's attempt.
  // This is defense-in-depth against cross-provider failover bugs.
  let effectivePlanId = planId
  if (input.providerPackageId) {
    const providerPackage = await prisma.providerPackage.findUnique({
      where: { id: input.providerPackageId },
      select: { id: true, providerId: true, providerPlanId: true, isAvailable: true },
    })

    if (!providerPackage) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), retryClassification: 'RETRYABLE', errorCode: 'PACKAGE_UNAVAILABLE', errorMessage: 'ProviderPackage not found for purchase attempt', metadata: { providerId, providerPackageId: input.providerPackageId } } })
      return { success: false, status: 'PACKAGE_UNAVAILABLE', errorCode: 'PACKAGE_UNAVAILABLE', errorMessage: 'ProviderPackage not found for purchase attempt' }
    }

    if (providerPackage.isAvailable === false) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), retryClassification: 'RETRYABLE', errorCode: 'PACKAGE_UNAVAILABLE', errorMessage: 'ProviderPackage is no longer available', metadata: { providerId, providerPackageId: input.providerPackageId } } })
      return { success: false, status: 'PACKAGE_UNAVAILABLE', errorCode: 'PACKAGE_UNAVAILABLE', errorMessage: 'This package is temporarily unavailable. Please try again later.' }
    }

    if (providerPackage.providerId !== provider.id) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), retryClassification: 'NON_RETRYABLE', errorCode: 'PROVIDER_PACKAGE_MISMATCH', errorMessage: `Provider package ${input.providerPackageId} belongs to provider ${providerPackage.providerId}, not ${provider.id}`, metadata: { providerId, providerPackageId: input.providerPackageId, ownedByProviderId: providerPackage.providerId } } })
      return { success: false, status: 'PROVIDER_PACKAGE_MISMATCH', errorCode: 'PROVIDER_PACKAGE_MISMATCH', errorMessage: 'Selected provider does not own the package bound to this purchase' }
    }

    // Derive the external provider plan id from the owning ProviderPackage.
    effectivePlanId = providerPackage.providerPlanId
  }

  // Validate config
  if (adapter.validatePurchase) {
    const v = await adapter.validatePurchase({ planId: effectivePlanId, quantity, subscriber })
    if (!v.valid) {
      await prisma.providerAttempt.update({ where: { id: attempt.id }, data: { status: 'SKIPPED', completedAt: new Date(), retryClassification: 'NON_RETRYABLE', errorCode: 'CONFIG_INVALID', errorMessage: v.reason } })
      return { success: false, status: 'CONFIG_INVALID', errorCode: 'PROVIDER_CONFIG', errorMessage: v.reason }
    }
  }

  // Stamp the provider we are about to mutate onto the order. Async-dispatched
  // orders are created without a provider; webhooks and stuck-order recovery
  // key off this column to match/poll/redispatch the correct provider.
  try { await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { providerId } }) } catch { /* non-fatal observability stamp */ }

  // Dispatch
  try {
    console.log(`[TRAVEL_DATE_TRACE] stage=DISPATCH travelDate=${travelDate || 'undefined'} provider=${providerName} orderId=${orderId}`)
    const result = await adapter.activateESIM({ planId: effectivePlanId, quantity, subscriber, activationType: 'ACTIVATE_NOW', externalId: businessId, orderId, ...(travelDate ? { travelDate } : {}) } as any)
    const latencyMs = Date.now() - startedAt.getTime()

    if (!result.success || !result.data) {
      const err = result.error
      const outcome = classifyProviderOutcome(err)

      if (outcome === 'AMBIGUOUS_PROVIDER_OUTCOME') {
        // The mutating activation may have reached the provider; the outcome is
        // UNKNOWN. Never retry the same provider, never fail over, never release
        // funds as though it definitely failed. Record enough for reconciliation.
        await prisma.providerAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'AMBIGUOUS', completedAt: new Date(), latencyMs, retryClassification: 'NON_RETRYABLE',
            errorCode: err?.code, errorMessage: err?.message,
            providerReference: err?.details?.providerOrderId || undefined,
            metadata: { ambiguous: true, reconciliationRequired: true, causeCode: err?.details?.causeCode ?? null, providerOrderId: err?.details?.providerOrderId ?? null, upstreamConfirmed: err?.details?.upstreamConfirmed === true },
          },
        })
        return { success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: 'Provider activation outcome is unknown (request may have completed); reconciliation required' }
      }

      const retryable = outcome === 'RETRYABLE_PRE_DISPATCH'
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', completedAt: new Date(), latencyMs, retryClassification: retryable ? 'RETRYABLE' : 'NON_RETRYABLE', errorCode: err?.code, errorMessage: err?.message, providerReference: (result.data as any)?.activationId },
      })
      return { success: false, status: retryable ? 'RETRYABLE' : 'FAILED', errorCode: err?.code, errorMessage: err?.message }
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

    // Normalized install payload from the connector result (per-user eSIM data).
    const raw = data as any
    const installData = {
      ...normalizeConnectorInstallData(data),
      rawMetadata: raw.rawMetadata && typeof raw.rawMetadata === 'object' ? raw.rawMetadata : undefined,
    }

    if (iccids.some(e => !e)) {
      // POST-DISPATCH: the HTTP call succeeded but the response lacks usable
      // ICCID data.  The provider may have already committed the activation —
      // this is AMBIGUOUS, never RETRYABLE.  Reconciliation decides.
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'AMBIGUOUS', completedAt: new Date(), latencyMs,
          retryClassification: 'NON_RETRYABLE',
          errorCode: 'INCOMPLETE_RESPONSE',
          errorMessage: 'Response missing ICCID data — activation may have succeeded',
          providerReference: providerOrderId || undefined,
          metadata: { ambiguous: true, reconciliationRequired: true, causeCode: 'INCOMPLETE_RESPONSE' },
        },
      })
      return { success: false, status: 'AMBIGUOUS', errorCode: 'INCOMPLETE_RESPONSE', errorMessage: 'Provider response is incomplete — reconciliation required' }
    }

    await completeProviderOperation({
      orderId, businessId, providerId, providerRef: providerOrderId || '', providerName: providerName || provider.name,
      totalAmount, iccids, userId: order.userId || undefined,
      packageSnapshot: order.packageSnapshot as any, packageName: order.packageName || '',
      packageDataGB: order.packageDataGB ?? undefined, packageValidityDays: order.packageValidityDays ?? undefined,
      ...installData,
    })

    await prisma.providerAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', completedAt: new Date(), latencyMs, providerReference: providerOrderId },
    })

    return { success: true, status: 'SUCCEEDED', providerReference: providerOrderId, iccids, qrCode: extractString(data.qrCodeUrl) || undefined }
  } catch (e: any) {
    const outcome = classifyProviderOutcome({ code: 'PROVIDER_ERROR', message: e.message })
    if (outcome === 'AMBIGUOUS_PROVIDER_OUTCOME') {
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: { status: 'AMBIGUOUS', completedAt: new Date(), latencyMs: Date.now() - startedAt.getTime(), retryClassification: 'NON_RETRYABLE', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: e.message?.substring(0, 500), metadata: { ambiguous: true, reconciliationRequired: true } },
      })
      return { success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: 'Provider activation outcome is unknown (request may have completed); reconciliation required' }
    }
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
