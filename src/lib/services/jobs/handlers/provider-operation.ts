import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { completeProviderOperation, failProviderOperation } from '../provider-finalizer'
import { normalizeConnectorInstallData, type ProviderInstallData } from '@/lib/esim/installation-data'
import { transitionOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { reconcileProviderOrder } from '@/lib/services/orders/reconciliation'

export type ActivationPollResolution =
  | 'COMPLETED'
  | 'FAILED'
  | 'STILL_PROCESSING'
  | 'RECONCILIATION_REQUIRED'

/**
 * Provider-neutral classification of a status-lookup ERROR for a pending
 * activation. The purchase was already dispatched, so a lookup failure must
 * NEVER be reported as a bogus PENDING and must NEVER release reserved wallet
 * funds. Real errors are preserved and routed:
 *   - TRANSIENT → the job retry mechanism re-polls (same provider, wallet held).
 *   - PERMANENT / AMBIGUOUS → reconciliation/manual review (wallet held,
 *     providerReference preserved). "Cannot confirm" is NOT "still processing".
 */
export function classifyActivationPollError(error: { code?: string; message?: string; details?: any } | undefined | null): ActivationPollResolution {
  if (!error) return 'RECONCILIATION_REQUIRED'
  const code = String(error.code || '').toUpperCase()
  const msg = String(error.message || '').toLowerCase()

  if (error.details?.ambiguous === true) return 'RECONCILIATION_REQUIRED'

  const transientCodes = ['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'MAINTENANCE', 'PROVIDER_ERROR']
  if (transientCodes.includes(code)) return 'STILL_PROCESSING'
  if (code.startsWith('HTTP_5')) return 'STILL_PROCESSING'
  if (/timeout|temporarily unavailable|try again later|maintenance|rate limit|502|503|504/.test(msg)) return 'STILL_PROCESSING'

  // Everything else (auth failure after refresh, HTTP 4xx contract errors,
  // documented not-found, unsupported status endpoint) is treated as an
  // unresolved, possibly-committed purchase → reconciliation, never a release.
  return 'RECONCILIATION_REQUIRED'
}

/**
 * Reconcile an activation job whose polling has ended without confirmation.
 * Provider-neutral: transition the order to PROVIDER_RECONCILIATION, PRESERVE
 * the reserved wallet, and keep the provider reference untouched. Only orders
 * still in a pre-fulfillment/pending state are touched; terminal orders are
 * left alone.
 */
export async function reconcileActivationOrder(orderId: string, reason: string): Promise<boolean> {
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, select: { status: true } })
  if (!order) return false
  if (['FULFILLED', 'CANCELLED', 'REFUNDED', 'FAILED', 'PROVIDER_RECONCILIATION'].includes(order.status)) return false
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION', message: reason })
  await transitionOrder(orderId, 'PROVIDER_RECONCILIATION', { reason }).catch(() => {})
  return true
}

/**
 * Exhaustion hook invoked by the queue when a PROVIDER_OPERATION activation job
 * reaches maxAttempts. Guards against a paid purchase being silently stranded
 * forever at PENDING_PROVIDER: transition to the existing reconciliation
 * lifecycle with the wallet still reserved.
 */
export async function reconcileExhaustedActivationJob(payload: any): Promise<void> {
  if (!payload?.orderId) return
  if (payload?.operation && payload.operation !== 'activation') return
  await reconcileActivationOrder(payload.orderId, 'Activation polling exhausted max attempts — provider may have accepted the purchase; reconciliation required')
}

export async function executeProviderOperation(payload: any): Promise<{ completed: boolean; error?: string }> {
  // Enqueued purchase dispatch (async purchase flow) → provider-neutral executor.
  if (payload?.operation === 'purchase') {
    const { executePurchaseDispatch } = await import('./purchase-execution')
    return executePurchaseDispatch(payload)
  }

  // ── Order-specific reconciliation ────────────────────────────────────
  // Route to the canonical `reconcileProviderOrder` engine.  This is the
  // ONLY path that should reach it from the job framework; all other
  // operations (activation polling, catalog sync) fall through.
  if (payload?.operation === 'reconciliation') {
    if (!payload.orderId) return { completed: false, error: 'Reconciliation requires orderId' }
    const order = await prisma.eSIMPurchase.findUnique({ where: { id: payload.orderId }, select: { status: true } })
    if (!order) return { completed: false, error: `Order ${payload.orderId} not found` }
    if (!['PROVIDER_RECONCILIATION', 'PENDING_PROVIDER'].includes(order.status)) {
      return { completed: true, error: `Order ${order.status} is not eligible for reconciliation` }
    }
    const result = await reconcileProviderOrder(payload.orderId)
    return { completed: true, error: result.outcome === 'STILL_PENDING' || result.outcome === 'UNSUPPORTED' ? result.message : undefined }
  }

  const { orderId, businessId, providerId, providerRef, totalAmount } = payload
  if (!orderId) return { completed: false, error: 'Missing orderId' }

  try {
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: orderId },
      include: { esims: true },
    })
    if (!order) return { completed: false, error: 'Order not found' }
    if (['FULFILLED', 'CANCELLED', 'REFUNDED'].includes(order.status)) return { completed: true }
    if (order.status === 'FAILED' && !payload.forceRetry) return { completed: true }
    if (order.status === 'PROVIDER_RECONCILIATION') return { completed: true }

    const provider = await prisma.provider.findUnique({ where: { id: providerId || order.providerId || '' } })
    if (!provider) {
      await reconcileActivationOrder(orderId, 'Provider record missing during status polling')
      return { completed: true, error: 'Provider not found — moved to reconciliation' }
    }

    const adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
      providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
    })

    let providerStatus = ''
    let providerIccids: string[] = []
    let installData: ProviderInstallData = {}

    // Status lookup. Any error is PRESERVED and classified provider-neutrally —
    // it is never silently converted into a fake PENDING state.
    let lookup: { success: boolean; data?: any; error?: { code?: string; message?: string } }
    if (typeof adapter.getActivationStatus === 'function' && providerRef) {
      try {
        lookup = await adapter.getActivationStatus(providerRef)
      } catch (e: any) {
        lookup = { success: false, error: { code: 'PROVIDER_ERROR', message: String(e?.message || 'Status lookup threw').substring(0, 300) } }
      }
    } else {
      lookup = { success: false, error: { code: 'NOT_SUPPORTED', message: 'Provider does not expose a status lookup for this reference' } }
    }

    if (lookup.success && lookup.data) {
      providerStatus = String(lookup.data.status || '').toUpperCase()
      providerIccids = (lookup.data.iccids || []).filter((v: any) => v != null && String(v).trim() !== '').map(String)
      installData = normalizeConnectorInstallData(lookup.data)

      // Terminal success — finalize idempotently (single eSIM, single capture).
      if (providerStatus === 'ACTIVE' || providerStatus === 'ACTIVATED') {
        if (providerIccids.length === 0 && !installData.activationCode) {
          await reconcileActivationOrder(orderId, 'Provider reports ACTIVE but returned no ICCID or activation evidence — cannot finalize')
          return { completed: true, error: 'Provider ACTIVE without fulfillment evidence — reconciliation' }
        }
        await completeProviderOperation({
          orderId, businessId: businessId || order.businessId, providerId: provider.id,
          providerRef, providerName: provider.name, totalAmount: totalAmount || Number(order.totalAmount),
          iccids: providerIccids, userId: order.userId || undefined,
          packageSnapshot: (order.packageSnapshot as any) ?? undefined,
          packageName: order.packageName || undefined,
          packageDataGB: order.packageDataGB ?? undefined,
          packageValidityDays: order.packageValidityDays ?? undefined,
          ...installData,
        })
        return { completed: true }
      }

      // Explicit terminal failure.
      if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(providerStatus)) {
        await failProviderOperation({
          orderId, businessId: businessId || order.businessId, providerId: provider.id,
          providerRef, totalAmount: totalAmount || Number(order.totalAmount),
          reason: `Provider operation ${providerStatus}: ${providerRef}`,
          userId: order.userId || undefined,
        })
        return { completed: true }
      }

      // Genuinee pending → retry via the job mechanism.
      return { completed: false, error: `Still processing: ${providerStatus || 'PENDING'}` }
    }

    // Lookup failed. Classify the ACTUAL error — never report a fake PENDING.
    const error = lookup.error || { code: 'PROVIDER_ERROR', message: 'Status lookup failed' }
    const resolution = classifyActivationPollError(error)
    if (resolution === 'STILL_PROCESSING') {
      return { completed: false, error: `Status lookup transient: ${error.code || 'UNKNOWN'} — ${error.message || ''}`.substring(0, 300) }
    }

    await reconcileActivationOrder(orderId, `Provider status lookup failed (${error.code || 'UNKNOWN'}) — ${error.message || ''}`)
    return { completed: true, error: `Status lookup ${error.code || 'UNKNOWN'} — moved to reconciliation` }
  } catch (error: any) {
    return { completed: false, error: error.message || 'Provider operation handler threw' }
  }
}