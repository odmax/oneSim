export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { batchSyncPendingEsims } from '@/lib/services/esims/sync-esim-status'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization') || ''
  const cronSecret = process.env.CRON_SECRET || ''

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await batchSyncPendingEsims()
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error('Cron sync-esim-status error:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}