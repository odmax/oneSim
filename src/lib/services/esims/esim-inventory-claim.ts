import { prisma } from '@/lib/prisma'

/**
 * Provider-neutral atomic eSIM ICCID claim.
 *
 * OneSIM's purchase/fulfillment layer owns durable DB claims. A connector
 * discovers eligible provider identities, then calls these neutral claim
 * operations BEFORE any provider mutation, so two concurrent purchases can
 * never select the same provider ICCID. Relies solely on the existing
 * `ESIM.iccid @unique` constraint — no schema change, no in-memory lock.
 */

/**
 * Atomically claim a provider ICCID for a purchase by inserting a temporary
 * eSIM row bound to `purchaseId`, keyed by the unique `iccid`.
 *
 * Claim row is non-final (`status: PROCESSING`) and carries NO fabricated
 * activation/install data. Returns:
 *   - `{ ok: true }`      when THIS call won the claim
 *   - `{ ok: false }`     when the ICCID is already claimed (P2002) — the
 *                         caller must try another eligible candidate
 *   - throws               on unexpected non-unique errors that must surface
 */
export async function claimProviderIccid(params: {
  purchaseId: string
  iccid: string
}): Promise<{ ok: boolean; reason?: string }> {
  const { purchaseId, iccid } = params
  if (!purchaseId) return { ok: false, reason: 'PURCHASE_ID_MISSING' }
  try {
    await prisma.eSIM.create({
      data: {
        purchaseId,
        iccid,
        status: 'PROCESSING',
        providerActivationId: '',
        providerSubscriptionId: null,
        providerStatus: null,
        expiresAt: null,
        statusNextSyncAt: null,
        usageNextSyncAt: null,
      },
    })
    return { ok: true }
  } catch (e: any) {
    const code = String(e?.code || '').toUpperCase()
    const msg = String(e?.message || '').toLowerCase()
    if (code === 'P2002' || msg.includes('unique') || msg.includes('already')) {
      return { ok: false, reason: 'CLAIM_LOST' }
    }
    // Unexpected — surface so the caller can fail loudly (never fabricate a claim).
    throw e
  }
}

/**
 * Ownership-safe release of a temporary ICCID claim.
 *
 * Deletes ONLY when ALL hold:
 *   - the row belongs to this purchaseId
 *   - status is still the non-final PROCESSING claim
 *   - providerActivationId is empty (not yet provider-bound)
 *   - activatedAt is null (not finalized)
 *
 * A row owned by another purchase, or any finalized/independently-owned eSIM,
 * is NEVER deleted.
 */
export async function releaseProviderIccidClaim(params: {
  purchaseId: string
  iccid: string
}): Promise<void> {
  const { purchaseId, iccid } = params
  if (!purchaseId) return
  const claim = await prisma.eSIM.findUnique({
    where: { iccid },
    select: { id: true, purchaseId: true, status: true, providerActivationId: true, activatedAt: true },
  })
  if (!claim) return
  const owner = claim.purchaseId === purchaseId
  const isUnfinalizedClaim = claim.status === 'PROCESSING' && !claim.providerActivationId && !claim.activatedAt
  if (owner && isUnfinalizedClaim) {
    await prisma.eSIM.delete({ where: { id: claim.id } }).catch(() => {})
  }
}

/**
 * Release every unfinalized PROCESSING claim bound to a purchase — used after a
 * provider-CONFIRMED failure (reconciliation FOUND_FAILURE) so ICCIDs held
 * through an ambiguous outcome return to inventory exactly once the existing
 * provider transaction is provably dead. Ownership-safe: only rows still in the
 * non-final claim state (status PROCESSING, no provider binding, no activation)
 * are deleted; finalized/provider-bound eSIMs are never touched.
 */
export async function releaseOrderClaimedIccids(purchaseId: string): Promise<void> {
  if (!purchaseId) return
  const claims = await prisma.eSIM.findMany({
    where: { purchaseId, status: 'PROCESSING', providerActivationId: '', activatedAt: null },
    select: { iccid: true },
  }).catch(() => [])
  for (const claim of claims as { iccid: string }[]) {
    await releaseProviderIccidClaim({ purchaseId, iccid: claim.iccid }).catch(() => {})
  }
}
