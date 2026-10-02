import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { runHourlyReconciliation, runDailyReconciliation, runWeeklyReconciliation } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PRODUCTS)
  if (!allowed) return denied

  const body = await request.json().catch(() => ({}))
  const type = body.type || 'hourly'
  const dryRun = body.dryRun !== false

  let result
  switch (type) {
    case 'hourly':
      result = await runHourlyReconciliation(dryRun)
      break
    case 'daily':
      result = await runDailyReconciliation(dryRun)
      break
    case 'weekly':
      result = await runWeeklyReconciliation(dryRun)
      break
    default:
      return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
  }

  return NextResponse.json(result)
}
