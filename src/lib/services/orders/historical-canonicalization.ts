import { prisma } from '@/lib/prisma'

/**
 * Guarded historical-data canonicalization (FIX B).
 *
 * Repairs persisted METADATA ONLY for legacy orders/eSIMs that reached a
 * canonical state through the pre-canonical reconciliation/finalization path:
 * stale fulfillment quantities, missing completion timestamp, cleared retry
 * scheduling, and legacy local-eSIM-UUID providerActivationId. It NEVER:
 *   - calls a provider (no POST, no read),
 *   - redispatches / fails over / reconciles,
 *   - touches wallet accounting (reserve/capture/release/refund) — wallet rows
 *     are READ-ONLY ledger evidence here,
 *   - calls transitionOrder / fulfillment / recovery,
 *   - derives or fabricates provider identity (authoritative C may ONLY come
 *     from an order.providerFulfillId that passes the eligibility guards), or
 *   - performs any provider status read or lifecycle derivation.
 *
 * Sync re-entry is limited to scheduling statusNextSyncAt so the normal
 * canonical ESIM_STATUS_SYNC path performs the actual provider read and
 * lifecycle derivation LATER; terminal eSIM statuses are never scheduled.
 *
 * The operation is idempotent and fail-closed: every write is a guarded
 * conditional update, and any financial/identity ambiguity skips (dry-run is
 * the default execution mode; `--apply` is explicit).
 */

export const HISTORICAL_TERMINAL_ESIM_STATUSES = ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']

export const HISTORICAL_SKIP_REASONS = [
  'ORDER_NOT_FULFILLED',
  'NO_PROVIDER_FULFILL_ID',
  'NO_ESIM_RECORD',
  'WALLET_CAPTURE_MISSING',
  'QUANTITY_UNPROVEN',
  'NO_CHANGES',
] as const

export const HISTORICAL_CONFLICT_REASONS = [
  'WALLET_MULTI_CAPTURE',
  'WALLET_RELEASE_OR_REFUND_PRESENT',
  'IDENTITY_CONFLICT',
] as const

export type HistoricalRepairReason =
  | 'REPAIRED'
  | 'ORDER_NOT_FULFILLED'
  | 'NO_PROVIDER_FULFILL_ID'
  | 'NO_ESIM_RECORD'
  | 'WALLET_CAPTURE_MISSING'
  | 'WALLET_MULTI_CAPTURE'
  | 'WALLET_RELEASE_OR_REFUND_PRESENT'
  | 'QUANTITY_UNPROVEN'
  | 'IDENTITY_CONFLICT'
  | 'NO_CHANGES'
  | 'ERROR'

export interface EsimRepairPlan {
  esimId: string
  iccid?: string | null
  terminal: boolean
  setSubscriptionId?: string
  setActivationId?: string
  schedule: boolean
}

export interface OrderRepairPlan {
  orderId: string
  reason: HistoricalRepairReason
  orderUpdate?: {
    fulfilledQuantity: number
    failedQuantity: number
    capturedAmount: number
    fulfillmentCompletedAt: Date
    nextRetryAt: null
    retryReason: null
  }
  esims: EsimRepairPlan[]
  /** True when the plan would produce at least one material write. */
  wouldChange: boolean
}

export interface RepairOutcome {
  orderId: string
  reason: HistoricalRepairReason
  repaired: boolean
}

export interface CanonicalizeInput {
  orderId?: string
  apply?: boolean
  batchSize?: number
}

export interface CanonicalizeResult {
  dryRun: boolean
  scanned: number
  eligible: number
  repaired: number
  skipped: number
  conflicts: number
  errors: number
  outcomes: RepairOutcome[]
}

/** Minimal read surface shared by the global prisma client and a tx client. */
type RepairDb = {
  eSIMPurchase: {
    findMany: typeof prisma.eSIMPurchase.findMany
    findUnique: typeof prisma.eSIMPurchase.findUnique
    updateMany: typeof prisma.eSIMPurchase.updateMany
  }
  eSIM: { updateMany: typeof prisma.eSIM.updateMany }
  walletTransaction: { findMany: typeof prisma.walletTransaction.findMany; count: typeof prisma.walletTransaction.count }
  providerAttempt: { findFirst: typeof prisma.providerAttempt.findFirst }
}

const isLocalIdentityInvalid = (providerActivationId: string | null | undefined, localEsimId: string): boolean => {
  if (!providerActivationId) return true
  return providerActivationId === localEsimId
}

/**
 * Deterministic completion timestamp precedence for a legacy FULFILLED order:
 *   1. order.statusChangedAt (the transition to FULFILLED)
 *   2. newest SUCCEEDED RECONCILIATION attempt completedAt
 *   3. newest PURCHASE attempt with a completedAt
 *   4. earliest WALLET_CAPTURE createdAt
 *   5. order.updatedAt — never a blind `now`
 */
async function deriveCompletionTimestamp(db: RepairDb, order: any, captures: Array<{ createdAt: Date }>): Promise<Date> {
  if (order.statusChangedAt) return new Date(order.statusChangedAt)
  const rec = await db.providerAttempt.findFirst({
    where: { orderId: order.id, source: 'RECONCILIATION', status: 'SUCCEEDED' },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  })
  if (rec?.completedAt) return new Date(rec.completedAt)
  const pur = await db.providerAttempt.findFirst({
    where: { orderId: order.id, source: 'PURCHASE', completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  })
  if (pur?.completedAt) return new Date(pur.completedAt)
  if (captures.length > 0) {
    const sorted = captures.map((c) => new Date(c.createdAt.getTime())).sort((a, b) => a.getTime() - b.getTime())
    return sorted[0]
  }
  return order.updatedAt ? new Date(order.updatedAt) : new Date()
}

/**
 * Fail-closed per-order planning. Reads only; computes the exact writes a
 * repair would make. Authoritative C is sourced EXCLUSIVELY from the order's
 * already-persisted providerFulfillId; it is never inferred from ICCID, from a
 * UUID shape, or from the local eSIM id.
 */
export async function planHistoricalOrderRepair(orderId: string, db: RepairDb): Promise<OrderRepairPlan> {
  const order = await db.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { esims: true },
  })
  if (!order || order.status !== 'FULFILLED') return { orderId, reason: 'ORDER_NOT_FULFILLED', esims: [], wouldChange: false }

  const C = String(order.providerFulfillId || '').trim()
  if (!C) return { orderId, reason: 'NO_PROVIDER_FULFILL_ID', esims: [], wouldChange: false }

  const esims: any[] = Array.isArray(order.esims) ? order.esims : []
  if (esims.length === 0) return { orderId, reason: 'NO_ESIM_RECORD', esims: [], wouldChange: false }

  // Wallet ledger is READ-ONLY evidence (fail closed on any ambiguity).
  const captures = await db.walletTransaction.findMany({
    where: { orderId, type: 'WALLET_CAPTURE' },
    select: { amount: true, createdAt: true },
  })
  const releases = await db.walletTransaction.count({ where: { orderId, type: 'WALLET_RELEASE' } })
  const refunds = await db.walletTransaction.count({ where: { orderId, type: 'WALLET_REFUND' } })
  if (captures.length === 0) return { orderId, reason: 'WALLET_CAPTURE_MISSING', esims: [], wouldChange: false }
  if (captures.length > 1) return { orderId, reason: 'WALLET_MULTI_CAPTURE', esims: [], wouldChange: false }
  if (releases > 0 || refunds > 0) return { orderId, reason: 'WALLET_RELEASE_OR_REFUND_PRESENT', esims: [], wouldChange: false }

  // Quantity derivation mirrors the canonical deriveOrderFulfillmentQuantities
  // (fulfillment.ts): fulfilled = unique persisted ICCIDs, capped at requested.
  // It is evidence-based — never quantity=N merely because order.status is
  // FULFILLED. Multi-quantity cases that cannot be proven are skipped.
  const requestedQuantity = order.quotedQuantity ?? order.quantity ?? 1
  const uniqueIccids = new Set(esims.map((e: any) => e.iccid).filter(Boolean))
  const fulfilledQuantity = Math.min(uniqueIccids.size, requestedQuantity)
  const failedQuantity = order.failedQuantity ?? 0
  if (fulfilledQuantity === 0 || (fulfilledQuantity < requestedQuantity && failedQuantity === 0)) {
    return { orderId, reason: 'QUANTITY_UNPROVEN', esims: [], wouldChange: false }
  }
  const capturedAmount = captures.reduce((sum, c) => sum + Math.abs(Number(c.amount ?? 0)), 0)
  const completionTimestamp = await deriveCompletionTimestamp(db, order, captures)

  // Identity repair with A/B/C invariants and fail-closed conflict handling.
  const esimPlans: EsimRepairPlan[] = []
  let identityConflict = false
  for (const e of esims as any[]) {
    if (HISTORICAL_TERMINAL_ESIM_STATUSES.includes(e.status)) {
      esimPlans.push({ esimId: e.id, iccid: e.iccid, terminal: true, schedule: false })
      continue
    }
    // C must never equal a local id or an ICCID (would indicate fabrication).
    if (C === e.id || (e.iccid && C === e.iccid)) {
      identityConflict = true
      break
    }
    let setSubscriptionId: string | undefined
    let setActivationId: string | undefined
    const sub = e.providerSubscriptionId ? String(e.providerSubscriptionId).trim() : ''
    if (sub === '') setSubscriptionId = C
    else if (sub !== C) { identityConflict = true; break }

    const act = e.providerActivationId ? String(e.providerActivationId).trim() : ''
    if (isLocalIdentityInvalid(act, e.id)) setActivationId = C
    else if (act !== C) { identityConflict = true; break }

    esimPlans.push({
      esimId: e.id,
      iccid: e.iccid,
      terminal: false,
      setSubscriptionId,
      setActivationId,
      schedule: e.statusNextSyncAt == null,
    })
  }
  if (identityConflict) return { orderId, reason: 'IDENTITY_CONFLICT', esims: [], wouldChange: false }

  // Order metadata stale detection (never blindly overwrite).
  const orderStale =
    order.fulfilledQuantity !== fulfilledQuantity ||
    order.failedQuantity !== failedQuantity ||
    order.capturedAmount == null ||
    Math.abs(Number(order.capturedAmount) - capturedAmount) > 0.000001 ||
    order.fulfillmentCompletedAt == null ||
    order.nextRetryAt != null ||
    order.retryReason != null

  const esimChanged = esimPlans.some((p) => !p.terminal && (p.setSubscriptionId || p.setActivationId || p.schedule))

  if (!orderStale && !esimChanged) return { orderId, reason: 'NO_CHANGES', esims: [], wouldChange: false }

  return {
    orderId,
    reason: 'REPAIRED',
    orderUpdate: orderStale
      ? {
          fulfilledQuantity,
          failedQuantity,
          capturedAmount,
          fulfillmentCompletedAt: completionTimestamp,
          nextRetryAt: null,
          retryReason: null,
        }
      : undefined,
    esims: esimPlans,
    wouldChange: true,
  }
}

interface AppliedRepair {
  reason: HistoricalRepairReason
  orderMatched: number
  esimsScheduled: number
  esimsSubscription: number
  esimsActivation: number
}

/** Apply a single order repair transactionally. Guards re-read inside the tx. */
async function applyOrderRepair(orderId: string): Promise<AppliedRepair> {
  let applied: AppliedRepair = { reason: 'NO_CHANGES', orderMatched: 0, esimsScheduled: 0, esimsSubscription: 0, esimsActivation: 0 }
  await prisma.$transaction(async (tx) => {
    const plan = await planHistoricalOrderRepair(orderId, tx as unknown as RepairDb)
    if (plan.reason !== 'REPAIRED' || !plan.wouldChange) {
      applied = { reason: plan.reason, orderMatched: 0, esimsScheduled: 0, esimsSubscription: 0, esimsActivation: 0 }
      return
    }
    if (plan.orderUpdate) {
      // Guarded conditional update: the stale predicate must still hold, so a
      // concurrent repair or a second pass matches nothing (concurrency +
      // idempotency).
      const res = await tx.eSIMPurchase.updateMany({
        where: {
          id: orderId,
          status: 'FULFILLED',
          OR: [{ fulfillmentCompletedAt: null }, { fulfilledQuantity: 0 }, { capturedAmount: null }, { nextRetryAt: { not: null } }],
        },
        data: plan.orderUpdate,
      })
      applied.orderMatched = res.count
    }
    for (const p of plan.esims) {
      if (p.terminal) continue
      if (p.setSubscriptionId) {
        const r = await tx.eSIM.updateMany({ where: { id: p.esimId, providerSubscriptionId: null }, data: { providerSubscriptionId: p.setSubscriptionId } })
        applied.esimsSubscription += r.count
      }
      if (p.setActivationId) {
        // Only re-point the provably-local legacy value (null or == esim.id).
        const r = await tx.eSIM.updateMany({
          where: { id: p.esimId, OR: [{ providerActivationId: null }, { providerActivationId: p.esimId }] },
          data: { providerActivationId: p.setActivationId },
        })
        applied.esimsActivation += r.count
      }
      if (p.schedule) {
        // Sync re-entry only — the provider read + lifecycle derivation happen
        // later in the normal canonical ESIM_STATUS_SYNC path. Terminal rows are
        // never scheduled (resurrection guard).
        const r = await tx.eSIM.updateMany({
          where: { id: p.esimId, statusNextSyncAt: null, status: { notIn: HISTORICAL_TERMINAL_ESIM_STATUSES } },
          data: { statusNextSyncAt: new Date(Date.now() + 60_000) },
        })
        applied.esimsScheduled += r.count
      }
    }
    const materialChanges = applied.orderMatched > 0 || applied.esimsScheduled > 0 || applied.esimsSubscription > 0 || applied.esimsActivation > 0
    applied.reason = materialChanges ? 'REPAIRED' : 'NO_CHANGES'
  })
  return applied
}

/**
 * Run the historical canonicalization pass.
 *
 * Dry-run by default; writes only with {@link CanonicalizeInput.apply}. Safe to
 * run repeatedly — a second --apply pass produces zero additional material
 * changes. Bounded, deterministic, and prints reason codes only.
 */
export async function canonicalizeHistoricalOrders(input: CanonicalizeInput = {}): Promise<CanonicalizeResult> {
  const dryRun = input.apply !== true
  const batchSize = input.batchSize ?? 25

  let orderIds: string[] = []
  if (input.orderId) {
    const hit = await prisma.eSIMPurchase.findMany({ where: { id: input.orderId }, select: { id: true }, take: 1 })
    orderIds = hit.map((o) => o.id)
  } else {
    const candidates = await prisma.eSIMPurchase.findMany({
      where: {
        status: 'FULFILLED',
        providerFulfillId: { not: null },
        OR: [{ fulfillmentCompletedAt: null }, { fulfilledQuantity: 0 }, { capturedAmount: null }, { nextRetryAt: { not: null } }],
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true },
    })
    orderIds = candidates.map((o) => o.id)
  }

  const outcomes: RepairOutcome[] = []
  for (const orderId of orderIds) {
    try {
      if (dryRun) {
        const plan = await planHistoricalOrderRepair(orderId, prisma as unknown as RepairDb)
        outcomes.push({ orderId, reason: plan.reason, repaired: plan.reason === 'REPAIRED' })
      } else {
        const applied = await applyOrderRepair(orderId)
        outcomes.push({ orderId, reason: applied.reason, repaired: applied.reason === 'REPAIRED' })
      }
    } catch (e: any) {
      outcomes.push({ orderId, reason: 'ERROR', repaired: false })
      console.log(`[HISTORICAL_REPAIR] error orderId=${orderId} reason=${e?.message?.substring(0, 200) || 'unknown'}`)
    }
  }

  const eligible = outcomes.filter((o) => o.reason === 'REPAIRED').length
  const conflicts = outcomes.filter((o) => (HISTORICAL_CONFLICT_REASONS as readonly string[]).includes(o.reason)).length
  const errors = outcomes.filter((o) => o.reason === 'ERROR').length
  const skipped = outcomes.length - eligible - conflicts - errors

  return { dryRun, scanned: orderIds.length, eligible, repaired: eligible, skipped, conflicts, errors, outcomes }
}