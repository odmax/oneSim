import { prisma } from '@/lib/prisma'
import { enqueueJob } from '@/lib/services/jobs/queue'
import { hasProviderAcceptanceEvidence, type ProviderReferenceOrderLike } from './provider-reference'

/**
 * Canonical stranded-order recovery engine.
 *
 * ONE discovery + ONE classifier + ONE queue operation (`operation: 'recovery'`
 * on PROVIDER_OPERATION). It runs naturally from the PROVIDER_SELF_HEAL
 * recurring job; the /api/internal/jobs/order-recovery route is a thin wrapper.
 *
 * Selection scope: orders stranded at PENDING_PROVIDER or
 * PROVIDER_RECONCILIATION whose nextRetryAt is null-or-due, within (or with
 * provider acceptance evidence beyond) the generic retry budget. The queued job
 * reuses `recoverOrder` (the P0-constrained classifier) as the authoritative
 * executor — it never blindly redispatchs when dispatch may have occurred.
 *
 * Deduplication is three-layered, so concurrent discovery passes / worker
 * instances / manual invocations can never run two competing recoveries:
 *   1. Discovery selects only null-or-due nextRetryAt orders and skips orders
 *      with an in-flight PROVIDER_OPERATION job.
 *   2. A time-bucketed idempotencyKey (`recovery:{orderId}:{10m bucket}`) makes
 *      every duplicate enqueue a rejected DB create, still distinct across
 *      buckets so later cycles are always schedulable.
 *   3. Execution takes a leased claim (nextRetryAt -> now + 5min) atomically;
 *      the loser of the claim returns without touching the order.
 */

export const RECOVERY_SCOPE_STATUSES = ['PENDING_PROVIDER', 'PROVIDER_RECONCILIATION'] as const

/** Lease held on nextRetryAt while a recovery pass executes (crash-safe re-claim). */
export const RECOVERY_CLAIM_MS = 5 * 60 * 1000

/** Idempotency bucket: attempts within the same 10-minute window share a key. */
export const RECOVERY_IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000

/** Anti-churn pause applied to orders the classifier declares NOT_RETRYABLE. */
export const RECOVERY_NOT_RETRYABLE_BACKOFF_MS = 60 * 60 * 1000

export const RECOVERY_DISCOVERY_BATCH_SIZE = 200
export const RECOVERY_JOB_MAX_ATTEMPTS = 5

const TERMINAL_RECOVERY_STATUSES = ['FULFILLED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'FAILED']

export interface RecoveryDiscoveryContext {
  source: 'PROVIDER_SELF_HEAL' | 'MANUAL' | 'OTHER'
}

export interface RecoveryDiscoveryResult {
  source: string
  scanned: number
  eligible: number
  enqueued: number
  duplicateSkipped: number
  skippedInFlight: number
  errors: string[]
}

/** Deterministic per-bucket recovery idempotency key (new key every 10 minutes). */
export function recoveryIdempotencyKey(orderId: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / RECOVERY_IDEMPOTENCY_BUCKET_MS) * RECOVERY_IDEMPOTENCY_BUCKET_MS
  return `recovery:${orderId}:${bucket}`
}

function isInRecoveryScope(status: string | null | undefined): boolean {
  return RECOVERY_SCOPE_STATUSES.includes((status || '') as any)
}

async function enqueueRecoveryJob(
  order: { id: string; providerId?: string | null; businessId?: string | null; totalAmount?: any },
  now: Date,
): Promise<'ENQUEUED' | 'DUPLICATE'> {
  const key = recoveryIdempotencyKey(order.id, now.getTime())
  try {
    await enqueueJob(
      'PROVIDER_OPERATION' as any,
      {
        operation: 'recovery',
        orderId: order.id,
        providerId: order.providerId ?? undefined,
        businessId: order.businessId ?? undefined,
        totalAmount: order.totalAmount != null ? Number(order.totalAmount) : undefined,
      },
      new Date(),
      RECOVERY_JOB_MAX_ATTEMPTS,
      key,
    )
    return 'ENQUEUED'
  } catch {
    // Unique idempotencyKey constraint — the same bucket is already queued.
    return 'DUPLICATE'
  }
}

async function hasInFlightRecoveryJob(orderId: string): Promise<boolean> {
  const active = await prisma.backgroundJob.findFirst({
    where: {
      type: 'PROVIDER_OPERATION' as any,
      status: { in: ['PENDING', 'PROCESSING'] } as any,
      payload: { path: ['orderId'], equals: orderId } as any,
    },
    select: { id: true },
  })
  return active != null
}

/** Single-order enqueue used by the manual/admin route (same semantics as discovery). */
export async function enqueueRecoveryForOrder(
  orderId: string,
  _context: RecoveryDiscoveryContext = { source: 'MANUAL' },
  now: Date = new Date(),
): Promise<{ enqueued: boolean; reason?: string }> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, providerId: true, businessId: true, totalAmount: true },
  })
  if (!order) return { enqueued: false, reason: 'Order not found' }
  if (!isInRecoveryScope(order.status)) {
    return { enqueued: false, reason: `Order status ${order.status} is outside recovery scope` }
  }
  if (await hasInFlightRecoveryJob(orderId)) {
    return { enqueued: false, reason: 'A recovery/reconciliation job is already scheduled or processing for this order' }
  }
  const result = await enqueueRecoveryJob(order, now)
  if (result === 'DUPLICATE') return { enqueued: false, reason: 'Duplicate recovery already enqueued for this window' }
  return { enqueued: true }
}

/**
 * Discovery pass: find stranded orders and enqueue one recovery operation each.
 * Called by the PROVIDER_SELF_HEAL recurring job (default) and the manual route.
 */
export async function discoverStrandedOrders(
  context: RecoveryDiscoveryContext = { source: 'PROVIDER_SELF_HEAL' },
  now: Date = new Date(),
): Promise<RecoveryDiscoveryResult> {
  const candidates = await prisma.eSIMPurchase.findMany({
    where: {
      status: { in: [...RECOVERY_SCOPE_STATUSES] } as any,
      OR: [{ nextRetryAt: { equals: null } }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { nextRetryAt: 'asc' as const },
    take: RECOVERY_DISCOVERY_BATCH_SIZE,
    select: {
      id: true,
      status: true,
      retryCount: true,
      maxRetries: true,
      nextRetryAt: true,
      providerId: true,
      businessId: true,
      totalAmount: true,
      providerFulfillId: true,
      providerReservationId: true,
    },
  })

  const result: RecoveryDiscoveryResult = {
    source: context.source,
    scanned: candidates.length,
    eligible: 0,
    enqueued: 0,
    duplicateSkipped: 0,
    skippedInFlight: 0,
    errors: [],
  }
  if (candidates.length === 0) return result

  // Batch provider-owned acceptance evidence so orders past the generic retry
  // budget stay recoverable read-only (mirrors the reconcile-continuation rule).
  const attempts = await prisma.providerAttempt
    .findMany({
      where: { orderId: { in: candidates.map((c) => c.id) } },
      orderBy: { attemptNumber: 'desc' as const },
      select: {
        orderId: true,
        providerId: true,
        providerReference: true,
        attemptNumber: true,
        startedAt: true,
        status: true,
        source: true,
        retryClassification: true,
        dispatchStartedAt: true,
      },
    })
    .catch(() => [] as any[])
  const attemptsByOrder = new Map<string, any[]>()
  for (const a of attempts as any[]) {
    const bucket = attemptsByOrder.get(a.orderId) || []
    bucket.push(a)
    attemptsByOrder.set(a.orderId, bucket)
  }

  const eligible = candidates.filter((c) => {
    if (c.maxRetries <= 0) return false
    if (c.retryCount < c.maxRetries) return true
    return hasProviderAcceptanceEvidence(c as ProviderReferenceOrderLike, attemptsByOrder.get(c.id) || [])
  })
  result.eligible = eligible.length
  if (eligible.length === 0) return result

  // Skip orders already covered by an in-flight PROVIDER_OPERATION job
  // (activation polling OR recovery) — never stack a parallel pass.
  const activeJobs = await prisma.backgroundJob
    .findMany({
      where: {
        type: 'PROVIDER_OPERATION' as any,
        status: { in: ['PENDING', 'PROCESSING'] } as any,
        OR: eligible.map((c) => ({ payload: { path: ['orderId'], equals: c.id } as any })),
      },
      select: { payload: true },
    })
    .catch(() => [] as any[])
  const inFlight = new Set<string>()
  for (const job of activeJobs as any[]) {
    const orderId = (job.payload as any)?.orderId
    if (typeof orderId === 'string') inFlight.add(orderId)
  }

  for (const c of eligible) {
    if (inFlight.has(c.id)) {
      result.skippedInFlight++
      continue
    }
    const enqueued = await enqueueRecoveryJob(c, now)
    if (enqueued === 'ENQUEUED') result.enqueued++
    else if (enqueued === 'DUPLICATE') result.duplicateSkipped++
  }
  return result
}

/**
 * PROVIDER_OPERATION `operation: 'recovery'` handler. Leased claim first, then
 * the canonical `recoverOrder` classifier executes. Returns completed even on
 * "still processing"/NOT_RETRYABLE — order-level nextRetryAt drives the next
 * pass; only infra crashes return completed:false (queue-level retry).
 */
export async function executeOrderRecovery(payload: any): Promise<{ completed: boolean; error?: string }> {
  const orderId = payload?.orderId
  if (!orderId) return { completed: false, error: 'Recovery requires orderId' }

  try {
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, retryCount: true, maxRetries: true, nextRetryAt: true },
    })
    if (!order) return { completed: false, error: `Order ${orderId} not found` }
    if (TERMINAL_RECOVERY_STATUSES.includes(order.status)) return { completed: true }

    // Leased claim via nextRetryAt (atomic conditional update). A crash after
    // the claim leaves nextRetryAt = now + 5min, so discovery re-runs the order
    // shortly; a concurrent pass finds the future nextRetryAt and skips.
    const claimUntil = new Date(Date.now() + RECOVERY_CLAIM_MS)
    const claimed = await prisma.eSIMPurchase.updateMany({
      where: {
        id: orderId,
        status: { in: [...RECOVERY_SCOPE_STATUSES] } as any,
        OR: [{ nextRetryAt: { equals: null } }, { nextRetryAt: { lte: new Date() } }],
      },
      data: { nextRetryAt: claimUntil },
    })
    if (claimed.count === 0) {
      return { completed: true, error: 'Order is already being recovered by another pass' }
    }

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder(orderId)

    if (result.action === 'NOT_RETRYABLE') {
      // Anti-churn: clearly-unrecoverable orders leave the 5-minute discovery
      // loop for an hour (reclassify slowly, never in a tight tick loop).
      await prisma.eSIMPurchase.updateMany({
        where: { id: orderId, status: { in: [...RECOVERY_SCOPE_STATUSES] } as any },
        data: { nextRetryAt: new Date(Date.now() + RECOVERY_NOT_RETRYABLE_BACKOFF_MS) },
      }).catch(() => {})
      return { completed: true, error: result.message }
    }

    return { completed: true, error: result.success ? undefined : result.message }
  } catch (e: any) {
    return { completed: false, error: e?.message || 'Order recovery failed' }
  }
}