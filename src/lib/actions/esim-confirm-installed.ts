'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

export interface ConfirmInstalledResult {
  ok: boolean
  /** True when the eSIM was already customer-confirmed (idempotent no-op). */
  alreadyConfirmed?: boolean
  error?: string
}

/**
 * Confirm that the customer installed an eSIM on a device.
 *
 * Authorization:
 *  - any authenticated BUSINESS_USER may confirm only an eSIM owned by their own
 *    business (tenant isolation via purchase.businessId);
 *  - an INTERNAL_ADMIN may confirm any eSIM.
 *
 * Durability & atomicity:
 *  - the timestamp write and the CUSTOMER_CONFIRMED_INSTALLED AuditLog row are
 *    written in ONE database transaction, so a confirmation can never record the
 *    actor without the timestamp (or vice versa);
 *  - the timestamp update is CONDITIONAL on customerConfirmedInstalledAt still
 *    being null (updateMany ... where null), so two concurrent requests cannot
 *    both create audit rows — exactly one wins, the other reports
 *    alreadyConfirmed=true as an idempotent no-op;
 *  - only `customerConfirmedInstalledAt` is ever written — provider evidence
 *    columns (status / installationStatus / providerStatus / providerResponse)
 *    are never touched, and status/usage syncs and provider webhooks never write
 *    this column, so the confirmation survives reload, polling, webhooks, and
 *    worker sync.
 */
export async function confirmEsimInstalledAction(esimId: string): Promise<ConfirmInstalledResult> {
  const session = await getServerSession(authOptions)
  if (!session || (session.user.role !== 'BUSINESS_USER' && session.user.role !== 'INTERNAL_ADMIN')) {
    return { ok: false, error: 'Not authorized' }
  }
  const isAdmin = session.user.role === 'INTERNAL_ADMIN'

  // Runtime tenant guard run BEFORE any database query: a BUSINESS_USER without
  // a non-empty businessId must be rejected outright. Never rely on a TS
  // non-null assertion (businessId!) for authorization.
  if (!isAdmin) {
    const businessId = session.user.businessId
    if (!businessId || String(businessId).trim() === '') {
      return { ok: false, error: 'Forbidden' }
    }
  }

  const where: any = { id: esimId }
  if (!isAdmin) where.purchase = { businessId: session.user.businessId }
  const esim = await prisma.eSIM.findFirst({
    where,
    select: { id: true, customerConfirmedInstalledAt: true },
  })
  if (!esim) return { ok: false, error: isAdmin ? 'eSIM not found' : 'Forbidden' }

  for (const p of ['/business/esims', '/admin/esims', `/admin/esims/${esimId}`]) revalidatePath(p)

  // Fast-path idempotency: an already-confirmed eSIM is an immediate no-op that
  // never re-enters the write transaction (no duplicate timestamp, no audit row).
  if (esim.customerConfirmedInstalledAt) return { ok: true, alreadyConfirmed: true }

  const registeredAt = new Date()

  // Atomic + conditional: the timestamp and its audit row are written together,
  // and the timestamp is only claimed while it is still null. If a concurrent
  // request already claimed it, updateMany matches 0 rows → no audit entry.
  const { claimed } = await prisma.$transaction(async (tx) => {
    const updated = await tx.eSIM.updateMany({
      where: { id: esimId, customerConfirmedInstalledAt: null },
      data: { customerConfirmedInstalledAt: registeredAt },
    })
    if (updated.count !== 1) return { claimed: false }
    await tx.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'CUSTOMER_CONFIRMED_INSTALLED',
        entity: 'ESIM',
        entityId: esimId,
        details: `Customer confirmed eSIM installed${isAdmin ? ' (confirmed by admin)' : ''}`,
      },
    })
    return { claimed: true }
  })

  // Someone else confirmed in the concurrent window — report the idempotent no-op.
  if (!claimed) return { ok: true, alreadyConfirmed: true }

  return { ok: true }
}