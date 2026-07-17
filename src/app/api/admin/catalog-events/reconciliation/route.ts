import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { runHourlyReconciliation, runDailyReconciliation, runWeeklyReconciliation } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
