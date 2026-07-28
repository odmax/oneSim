export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { checkAllProvidersHealth } from '@/lib/providers/health-check'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization') || ''
  const cronSecret = process.env.CRON_SECRET || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await checkAllProvidersHealth()
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error('Cron provider-health error:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}