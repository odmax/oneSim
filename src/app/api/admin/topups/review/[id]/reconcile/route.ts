export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { manualRetryTopUpReconciliation } from '@/lib/services/topups/top-up-reconciliation'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

/**
 * Admin safe action: Retry Reconciliation.
 * Uses the exact same reconciliation path as the background job (forced now).
 * This NEVER re-dispatches the provider top-up mutation — only read-only status
 * verification plus the idempotent wallet capture/release resolution.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_WALLETS)
  if (!allowed) return denied

  const { id } = params
  if (!id) return NextResponse.json({ error: 'Missing top-up id' }, { status: 400 })

  try {
    const result = await manualRetryTopUpReconciliation(id)
    return NextResponse.json({ success: true, result })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'Reconciliation retry failed' }, { status: 500 })
  }
}
