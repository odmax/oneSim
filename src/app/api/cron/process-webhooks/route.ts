import { NextRequest, NextResponse } from 'next/server'
import { processPendingWebhookDeliveries } from '@/lib/services/business-webhooks/dispatcher'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization') || ''
  const cronSecret = process.env.CRON_SECRET || ''

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await processPendingWebhookDeliveries()
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error('Cron process-webhooks error:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}