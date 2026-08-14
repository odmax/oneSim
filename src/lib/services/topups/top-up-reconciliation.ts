import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'
import { captureTopUpFundsUpToInTx, releaseTopUpFundsUpToInTx } from '@/lib/services/orders/wallet-actions'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'

/**
 * Top-up reconciliation — the safe recovery path for ESIMTopUp.PENDING_REVIEW.
 *
 * Invariants (do NOT violate):
 * - NEVER re-dispatches the provider top-up mutation. Only read-only status/usage
 *   lookups (`getActivationStatus` / `getUsage`) are allowed from this module.
 * - The charge is the IMMUTABLE quoted amount (`quotedTotalAmount`), never a value
 *   derived from a provider response.
 * - Wallet reserve stays untouched while the outcome is unknown. FOUND_SUCCESS
 *   captures up to the quoted amount once; FOUND_FAILURE releases the outstanding
 *   reserved remainder once. Both paths are idempotent (cumulative ledger).
 * - Each top-up is claimed with a lease before work so two workers never reconcile
 *   the same row; a crashed worker's lease expires and the row is reclaimable.
 */

export type ReconcileOutcome = 'FOUND_SUCCESS' | 'FOUND_FAILURE' | 'STILL_UNKNOWN'

export interface ReconcileEvidence {
  status?: string
  rawStatus?: string
  expiresAt?: string
  dataTotalMB?: number
  dataRemainingMB?: number
  dataAddedMB?: number
  validityDaysAdded?: number
  providerReference?: string
  providerResponse?: Record<string, any>
  reason?: string
  errorCode?: string
}

export interface ReconcileResult {
  topUpId: string
  outcome: ReconcileOutcome
  skipped?: boolean
  applied?: boolean
  escalated?: boolean
  error?: string
  nextReconcileAt?: string | null
}

export interface ReconcileCapability {
  verifiable: boolean
  method: 'STATUS_BY_ICCID' | 'USAGE_BY_ICCID' | 'NONE'
  evidence: string
  note: string
}

// ──────────────────────────────────────────────────────────────────────────
// Retry / escalation policy
// attempt 1 → +5 min, attempt 2 → +15 min, attempt 3 → +30 min, attempt 4 → +2h,
// attempt 5+ → NEEDS_REVIEW (escalate to manual intervention).
// ──────────────────────────────────────────────────────────────────────────

export const RECONCILE_BACKOFF_MINUTES = [5, 15, 30, 120]
export const RECONCILE_ESCALATION_THRESHOLD = RECONCILE_BACKOFF_MINUTES.length
export const RECONCILE_LEASE_MS = 5 * 60 * 1000

export function getNextReconcileDelayMinutes(attempt: number): number | null {
  if (attempt <= 0) return 0
  if (attempt <= RECONCILE_BACKOFF_MINUTES.length) return RECONCILE_BACKOFF_MINUTES[attempt - 1]
  return null
}

export function getNextReconcileAt(attempt: number): Date | null {
  const delay = getNextReconcileDelayMinutes(attempt)
  if (delay == null) return null
  return new Date(Date.now() + delay * 60 * 1000)
}

/** The immutable charge for a top-up — provider responses never change it. */
export function resolveTopUpCharge(topUp: { quotedTotalAmount?: any; amount: any }): number {
  const quoted = Number(topUp.quotedTotalAmount)
  return Number.isFinite(quoted) && quoted > 0 ? quoted : Number(topUp.amount)
}

// ──────────────────────────────────────────────────────────────────────────
// Provider reconciliation capability matrix
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-provider read-only verification capability. `NONE` means the provider
 * cannot safely verify top-up state — the top-up stays PENDING_REVIEW and
 * escalates after the retry threshold. We NEVER guess success/failure.
 */
export function resolveReconcileCapability(provider: {
  adapterStrategy?: string | null
  type?: string | null
  code?: string | null
  statusPath?: string | null
}): ReconcileCapability {
  const strategy = provider.adapterStrategy || provider.type || ''

  switch (strategy) {
    case 'CHOICE':
    case 'URL_TOKEN':
      return {
        verifiable: true,
        method: 'STATUS_BY_ICCID',
        evidence: 'Choice package_detail: normalized package_status + data totals / expiry vs quoted baseline',
        note: 'Read-only package_detail lookup by ICCID (fallback IMSI). Requires esim.iccid.',
      }
    case 'AIRHUB':
      return {
        verifiable: false,
        method: 'NONE',
        evidence: 'AirHub connector topUpESIM returns NOT_SUPPORTED',
        note: 'AirHub never dispatches a top-up mutation, so it never reaches PENDING_REVIEW. If one ever appears, it must be reviewed manually.',
      }
    case 'IBASIS':
      return {
        verifiable: false,
        method: 'NONE',
        evidence: 'iBASIS connector topUpESIM returns NOT_IMPLEMENTED',
        note: 'iBASIS never dispatches a top-up mutation, so it never reaches PENDING_REVIEW. If one ever appears, it must be reviewed manually.',
      }
    default:
      // STANDARD / generic / unknown — no trustworthy read-only verification of
      // a top-up result. Keep reserved; escalate after threshold.
      return {
        verifiable: false,
        method: 'NONE',
        evidence: `No read-only top-up verification for strategy "${strategy || 'unknown'}"`,
        note: 'No safe verification path. Funds stay reserved; escalate after the retry threshold.',
      }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Claiming (concurrency + crash lease)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Atomically claim a PENDING_REVIEW top-up for reconciliation.
 * Only succeeds when the row is: still PENDING_REVIEW, not escalated, due for a
 * retry (nextReconcileAt in the past or unset), and not currently locked by a
 * live worker lease. The claim increments `reconciliationAttempts`.
 */
export async function claimTopUpForReconciliation(topUpId: string, workerId: string): Promise<boolean> {
  const now = new Date()
  const leaseCutoff = new Date(now.getTime() - RECONCILE_LEASE_MS)

  const result = await prisma.eSIMTopUp.updateMany({
    where: {
      id: topUpId,
      status: 'PENDING_REVIEW',
      reconciliationEscalatedAt: null,
      AND: [
        { OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: now } }] },
        { OR: [{ reconcileLockedAt: null }, { reconcileLockedAt: { lt: leaseCutoff } }] },
      ],
    },
    data: {
      reconcileLockedAt: now,
      reconcileLockOwner: workerId,
      lastReconcileAt: now,
      reconciliationAttempts: { increment: 1 },
    },
  })

  return result.count === 1
}

async function releaseClaim(topUpId: string): Promise<void> {
  await prisma.eSIMTopUp.updateMany({
    where: { id: topUpId },
    data: { reconcileLockedAt: null, reconcileLockOwner: null },
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Read-only provider verification
// ──────────────────────────────────────────────────────────────────────────

function normalizeStatusValue(status: string | undefined | null): string {
  return String(status || '').trim().toUpperCase()
}

function parseProviderExpiry(value: unknown): Date | null {
  if (value == null) return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Verify a pending-review top-up using ONLY read-only provider lookups.
 * Returns FOUND_SUCCESS / FOUND_FAILURE / STILL_UNKNOWN. STILL_UNKNOWN keeps the
 * reservation held and schedules a later retry.
 */
export async function verifyTopUpState(topUp: {
  id: string
  esimId: string
  providerId: string | null
}): Promise<{ outcome: ReconcileOutcome; evidence?: ReconcileEvidence; errorCode?: string }> {
  if (!topUp.providerId) return { outcome: 'STILL_UNKNOWN', errorCode: 'NO_PROVIDER' }

  const [esim, provider] = await Promise.all([
    prisma.eSIM.findUnique({ where: { id: topUp.esimId }, select: { id: true, iccid: true, imsi: true, expiresAt: true, dataTotalMB: true, dataRemainingMB: true, purchaseId: true } }),
    prisma.provider.findUnique({ where: { id: topUp.providerId } }),
  ])
  if (!esim || !provider) return { outcome: 'STILL_UNKNOWN', errorCode: esim ? 'PROVIDER_NOT_FOUND' : 'ESIM_NOT_FOUND' }

  const capability = resolveReconcileCapability(provider)
  if (!capability.verifiable) return { outcome: 'STILL_UNKNOWN', errorCode: 'PROVIDER_VERIFICATION_UNSUPPORTED' }

  if (!esim.iccid) return { outcome: 'STILL_UNKNOWN', errorCode: 'NO_ICCID' }

  const adapter = await getAdapterForProvider(provider.id)
  if (!adapter) return { outcome: 'STILL_UNKNOWN', errorCode: 'ADAPTER_UNAVAILABLE' }

  const lookup = { iccid: esim.iccid, ...(esim.imsi ? { imsi: esim.imsi } : {}) }

  // READ-ONLY: status lookup only. The top-up mutation is NEVER re-dispatched.
  let statusData: any
  try {
    const statusResult = await adapter.getActivationStatus(lookup as any)
    if (!statusResult.success) {
      // A lookup-level error (timeout/network/endpoint) is not confirmation of
      // failure — keep funds reserved and retry later.
      return { outcome: 'STILL_UNKNOWN', errorCode: statusResult.error?.code || 'STATUS_LOOKUP_FAILED', evidence: { errorCode: statusResult.error?.code, reason: statusResult.error?.message } }
    }
    statusData = statusResult.data || {}
  } catch (e: any) {
    return { outcome: 'STILL_UNKNOWN', errorCode: 'STATUS_LOOKUP_ERROR', evidence: { errorCode: 'STATUS_LOOKUP_ERROR', reason: e?.message?.slice(0, 200) } }
  }

  const normalized = normalizeStatusValue(statusData.status)

  // Definite failure evidence: the subscription itself is dead.
  if (normalized === 'FAILED' || normalized === 'CANCELLED') {
    return {
      outcome: 'FOUND_FAILURE',
      evidence: { status: normalized, rawStatus: statusData.rawStatus, errorCode: `PROVIDER_STATUS_${normalized}`, reason: `Provider reports subscription ${normalized}` },
    }
  }

  // READ-ONLY: usage totals (Choice package_detail) for data-advance evidence.
  let usageData: any
  try {
    const usageResult = await adapter.getUsage(lookup as any)
    if (usageResult.success) usageData = usageResult.data || {}
  } catch {
    // non-fatal — expiry evidence may still resolve the outcome
  }

  const topUpPkg = await prisma.eSIMPackage.findUnique({
    where: { id: (topUp as any).packageId },
    select: { dataGB: true, validityDays: true },
  }).catch(() => null)

  const quotedDataMB = topUpPkg?.dataGB ? topUpPkg.dataGB * 1024 : null
  const baselineDataMB = esim.dataTotalMB
  const providerTotalMB = usageData?.dataTotalMB
  const providerExpiry = statusData.expiresAt || statusData.rateGroupExpire || usageData?.expiresAt
  const baselineExpiry = esim.expiresAt
  const quotedValidityDays = topUpPkg?.validityDays ?? null

  // Positive evidence — the top-up is reflected in the subscription.
  let successEvidence = false

  // 1. Data total advanced by at least the quoted data amount.
  if (successEvidence === false && providerTotalMB != null && baselineDataMB != null && quotedDataMB != null) {
    if (Number(providerTotalMB) >= Number(baselineDataMB) + quotedDataMB - 1) successEvidence = true
  }
  // 2. Expiry advanced by at least the quoted validity.
  if (successEvidence === false && providerExpiry && baselineExpiry && quotedValidityDays) {
    const advanced = parseProviderExpiry(providerExpiry)
    if (advanced && advanced.getTime() >= baselineExpiry.getTime() + quotedValidityDays * 86400000 - 3600000) successEvidence = true
  }

  if (normalized === 'ACTIVE' && successEvidence) {
    return {
      outcome: 'FOUND_SUCCESS',
      evidence: {
        status: normalized,
        rawStatus: statusData.rawStatus,
        expiresAt: providerExpiry || undefined,
        dataTotalMB: providerTotalMB != null ? Number(providerTotalMB) : undefined,
        dataRemainingMB: usageData?.dataRemainingMB != null ? Number(usageData.dataRemainingMB) : undefined,
        providerResponse: statusData.rawMetadata || usageData?.rawMetadata,
      },
    }
  }

  return { outcome: 'STILL_UNKNOWN', errorCode: 'NO_CONFIRMATION', evidence: { status: normalized, rawStatus: statusData.rawStatus } }
}

// ──────────────────────────────────────────────────────────────────────────
// Outcome application (idempotent)
// ──────────────────────────────────────────────────────────────────────────

async function applySuccess(topUp: {
  id: string
  businessId: string
  currency: string
  providerId: string | null
  quotedTotalAmount?: any
  amount: any
  dataAddedMB?: number | null
  validityDaysAdded?: number | null
  providerReference?: string | null
}, esim: { id: string; iccid: string; purchaseId: string; expiresAt: Date | null }, evidence: ReconcileEvidence): Promise<{ ok: boolean; error?: string }> {
  const charge = resolveTopUpCharge(topUp)
  const dataAddedMB = topUp.dataAddedMB ?? evidence.dataAddedMB ?? undefined
  const validityDays = topUp.validityDaysAdded ?? evidence.validityDaysAdded ?? undefined

  try {
    await prisma.$transaction(async (tx) => {
      // Guarded transition: only a still-PENDING_REVIEW row may complete.
      const claimed = await tx.eSIMTopUp.updateMany({
        where: { id: topUp.id, status: 'PENDING_REVIEW' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          lastReconcileErrorCode: null,
          ...(evidence.providerResponse ? { providerResponse: evidence.providerResponse as any } : {}),
          ...(evidence.providerReference || topUp.providerReference ? { providerReference: (evidence.providerReference || topUp.providerReference) as string } : {}),
          ...(dataAddedMB != null ? { dataAddedMB } : {}),
          ...(validityDays != null ? { validityDaysAdded: validityDays } : {}),
        },
      })
      if (claimed.count !== 1) throw new Error('Top-up is no longer pending review')

      // Capture outstanding reserved funds once, capped at the immutable quote.
      const capture = await captureTopUpFundsUpToInTx(tx, topUp.id, topUp.businessId, charge)
      if (!capture.success) throw new Error(capture.error || 'Wallet capture failed')

      // Persist provider-confirmed subscription state (read-only evidence only).
      const updateData: any = {}
      if (evidence.expiresAt) {
        const d = parseProviderExpiry(evidence.expiresAt)
        if (d) updateData.expiresAt = d
      }
      if (!updateData.expiresAt && validityDays) {
        updateData.expiresAt = esim.expiresAt
          ? new Date(esim.expiresAt.getTime() + validityDays * 86400000)
          : new Date(Date.now() + validityDays * 86400000)
      }
      if (evidence.dataTotalMB != null) updateData.dataTotalMB = evidence.dataTotalMB
      if (evidence.dataRemainingMB != null) updateData.dataRemainingMB = evidence.dataRemainingMB
      if (Object.keys(updateData).length > 0) await tx.eSIM.update({ where: { id: esim.id }, data: updateData })

      // Invoice (idempotent — one per top-up).
      let invoiceId: string | undefined
      const existingInvoice = await tx.invoice.findUnique({ where: { topUpId: topUp.id } })
      if (existingInvoice) {
        invoiceId = existingInvoice.id
      } else {
        const ts = Date.now().toString(36).toUpperCase()
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber: `TOP-${ts}-${rand}`,
            businessId: topUp.businessId,
            topUpId: topUp.id,
            type: 'TOPUP',
            amount: charge,
            currency: topUp.currency,
            status: 'PAID',
            paidAt: new Date(),
          },
        })
        invoiceId = inv.id
      }

      // Billing record for finance P&L (idempotent per invoice).
      if (invoiceId) {
        const existingBilling = await tx.billingRecord.findFirst({ where: { invoiceId, type: 'TOPUP' } })
        if (!existingBilling) {
          await tx.billingRecord.create({
            data: {
              businessId: topUp.businessId,
              esimId: esim.id,
              invoiceId,
              type: 'TOPUP',
              amount: charge,
              currency: topUp.currency,
              providerId: topUp.providerId,
              description: `Top-up completed via reconciliation (${esim.iccid})`,
            },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          userId: 'system',
          action: 'ESIM_TOPUP_RECONCILED',
          entity: 'ESIMTopUp',
          entityId: topUp.id,
          details: JSON.stringify({ topUpId: topUp.id, outcome: 'FOUND_SUCCESS', amount: charge, currency: topUp.currency }),
        },
      })
    })

    await createTimelineEvent(esim.purchaseId, {
      eventType: 'TOPUP_RECONCILED',
      message: `Top-up reconciled as success (${esim.iccid.slice(-8)})`,
    }).catch(() => {})
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 500) || 'Completion failed' }
  }
}

async function applyFailure(topUp: {
  id: string
  businessId: string
  currency: string
  providerId: string | null
  quotedTotalAmount?: any
  amount: any
}, esim: { id: string; iccid: string; purchaseId: string }, evidence: ReconcileEvidence): Promise<{ ok: boolean; error?: string }> {
  const charge = resolveTopUpCharge(topUp)
  try {
    await prisma.$transaction(async (tx) => {
      // Guarded transition + release are atomic: if the release cannot be written,
      // the status stays PENDING_REVIEW so a later attempt completes the recovery.
      const claimed = await tx.eSIMTopUp.updateMany({
        where: { id: topUp.id, status: 'PENDING_REVIEW' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: (evidence.reason || 'Provider confirmed top-up failure').slice(0, 500),
          lastReconcileErrorCode: evidence.errorCode || 'FOUND_FAILURE',
        },
      })
      if (claimed.count !== 1) throw new Error('Top-up is no longer pending review')

      const released = await releaseTopUpFundsUpToInTx(tx, topUp.id, topUp.businessId, charge)
      if (!released.success) throw new Error(released.error || 'Wallet release failed')

      await tx.auditLog.create({
        data: {
          userId: 'system',
          action: 'ESIM_TOPUP_RECONCILED',
          entity: 'ESIMTopUp',
          entityId: topUp.id,
          details: JSON.stringify({ topUpId: topUp.id, outcome: 'FOUND_FAILURE', amount: charge, currency: topUp.currency }),
        },
      })
    })

    await createTimelineEvent(esim.purchaseId, {
      eventType: 'TOPUP_FAILED',
      message: `Top-up reconciled as failure — funds released (${esim.iccid.slice(-8)})`,
    }).catch(() => {})
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 500) || 'Failure finalization failed' }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestration
// ──────────────────────────────────────────────────────────────────────────

/**
 * Reconcile ONE pending-review top-up. Claims it first (lease) so a single row
 * is only processed by one worker at a time. Never re-dispatches the provider
 * top-up mutation. `force` (admin manual retry) ignores the retry schedule and
 * clears any escalation before attempting.
 */
export async function reconcileTopUpById(topUpId: string, workerId: string, opts?: { force?: boolean }): Promise<ReconcileResult> {
  if (opts?.force) {
    await prisma.eSIMTopUp.updateMany({
      where: { id: topUpId, status: 'PENDING_REVIEW' },
      data: { reconciliationEscalatedAt: null, nextReconcileAt: new Date() },
    })
  }

  const claimed = await claimTopUpForReconciliation(topUpId, workerId)
  if (!claimed) return { topUpId, outcome: 'STILL_UNKNOWN', skipped: true }

  const topUp = await prisma.eSIMTopUp.findUnique({ where: { id: topUpId } })
  if (!topUp) return { topUpId, outcome: 'STILL_UNKNOWN', skipped: true }
  if (topUp.status !== 'PENDING_REVIEW') {
    await releaseClaim(topUpId)
    return { topUpId, outcome: 'STILL_UNKNOWN', skipped: true }
  }

  const attempts = topUp.reconciliationAttempts
  const verification = await verifyTopUpState(topUp)
  const outcome = verification.outcome
  const evidence = verification.evidence || {}
  const errorCode = verification.errorCode || evidence.errorCode

  // Resolve the eSIM once for side effects / timeline events.
  const esim = await prisma.eSIM.findUnique({ where: { id: topUp.esimId }, select: { id: true, iccid: true, purchaseId: true, expiresAt: true } })

  if (outcome === 'FOUND_SUCCESS' && esim) {
    const applied = await applySuccess(topUp as any, esim as any, evidence)
    await releaseClaim(topUpId)
    if (!applied.ok) {
      await scheduleOrEscalate(topUpId, attempts, applied.error || 'COMPLETION_FAILED')
      return { topUpId, outcome, applied: false, error: applied.error, nextReconcileAt: (await getNextReconcileAtString(topUpId)) }
    }
    return { topUpId, outcome, applied: true }
  }

  if (outcome === 'FOUND_FAILURE' && esim) {
    const applied = await applyFailure(topUp as any, esim as any, evidence)
    await releaseClaim(topUpId)
    if (!applied.ok) {
      await scheduleOrEscalate(topUpId, attempts, applied.error || 'RELEASE_FAILED')
      return { topUpId, outcome, applied: false, error: applied.error, nextReconcileAt: (await getNextReconcileAtString(topUpId)) }
    }
    return { topUpId, outcome, applied: true }
  }

  // STILL_UNKNOWN (or side-effect failure already re-scheduled): keep funds
  // reserved, schedule the next attempt, escalate after the threshold.
  const scheduled = await scheduleOrEscalate(topUpId, attempts, errorCode)
  await releaseClaim(topUpId)
  return { topUpId, outcome: 'STILL_UNKNOWN', applied: false, escalated: scheduled.escalated, error: errorCode || undefined, nextReconcileAt: scheduled.nextReconcileAt?.toISOString() || null }
}

async function getNextReconcileAtString(topUpId: string): Promise<string | null> {
  const row = await prisma.eSIMTopUp.findUnique({ where: { id: topUpId }, select: { nextReconcileAt: true } })
  return row?.nextReconcileAt?.toISOString() || null
}

async function scheduleOrEscalate(topUpId: string, attempts: number, errorCode?: string): Promise<{ escalated: boolean; nextReconcileAt: Date | null }> {
  if (attempts >= RECONCILE_ESCALATION_THRESHOLD) {
    await prisma.eSIMTopUp.update({
      where: { id: topUpId },
      data: {
        reconciliationEscalatedAt: new Date(),
        nextReconcileAt: null,
        lastReconcileErrorCode: errorCode || 'ESCALATED',
      },
    })
    return { escalated: true, nextReconcileAt: null }
  }

  const next = getNextReconcileAt(attempts)
  await prisma.eSIMTopUp.update({
    where: { id: topUpId },
    data: {
      nextReconcileAt: next,
      lastReconcileErrorCode: errorCode || null,
    },
  })
  return { escalated: false, nextReconcileAt: next }
}

/**
 * Batch entry point used by the TOPUP_RECONCILIATION background job.
 * Processes the oldest/least-retried due rows first. Recurring + idempotent.
 */
export async function runTopUpReconciliationBatch(batchSize = 20, workerId?: string): Promise<{
  processed: number
  success: number
  failure: number
  unknown: number
  escalated: number
  skipped: number
}> {
  const id = workerId || `topup-recon-${Math.random().toString(36).slice(2, 10)}`

  const candidates = await prisma.eSIMTopUp.findMany({
    where: {
      status: 'PENDING_REVIEW',
      reconciliationEscalatedAt: null,
      AND: [
        { OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: new Date() } }] },
        { OR: [{ reconcileLockedAt: null }, { reconcileLockedAt: { lt: new Date(Date.now() - RECONCILE_LEASE_MS) } }] },
      ],
    },
    orderBy: [{ reconciliationAttempts: 'asc' }, { createdAt: 'asc' }],
    take: batchSize,
    select: { id: true },
  })

  const stats = { processed: 0, success: 0, failure: 0, unknown: 0, escalated: 0, skipped: 0 }

  for (const candidate of candidates) {
    const result = await reconcileTopUpById(candidate.id, id)
    if (result.skipped) { stats.skipped++; continue }
    stats.processed++
    if (result.outcome === 'FOUND_SUCCESS') stats.success++
    else if (result.outcome === 'FOUND_FAILURE') stats.failure++
    else stats.unknown++
    if (result.escalated) stats.escalated++
  }

  return stats
}

/**
 * Admin manual retry — uses the exact same reconciliation path as the background
 * job, just forced now. Clears escalation so a fresh attempt runs immediately.
 */
export async function manualRetryTopUpReconciliation(topUpId: string): Promise<ReconcileResult> {
  return reconcileTopUpById(topUpId, `admin-retry-${Math.random().toString(36).slice(2, 10)}`, { force: true })
}
