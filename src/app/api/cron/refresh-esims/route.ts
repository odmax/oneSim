import { NextResponse } from 'next/server'
import { refreshAllActiveStatuses, refreshAllUsage, markExpiredESIMs } from '@/lib/services/esims/esim-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const action = new URL(request.url).searchParams.get('action') || 'all'
    const results: Record<string, any> = {}

    if (action === 'status' || action === 'all') {
      results.status = await refreshAllActiveStatuses()
    }

    if (action === 'usage' || action === 'all') {
      results.usage = await refreshAllUsage()
    }

    if (action === 'expire' || action === 'all') {
      results.expired = await markExpiredESIMs()
    }

    return NextResponse.json({ success: true, action, ...results, timestamp: new Date().toISOString() })
  } catch (e: any) {
    console.error('Cron refresh-esims error:', e)
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
