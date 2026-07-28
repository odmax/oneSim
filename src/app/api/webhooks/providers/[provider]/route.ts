export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { receiveProviderWebhook } from '@/lib/services/webhooks/provider-webhook-processor'

function getSecret(providerType: string): string {
  const envKey = `${providerType.toUpperCase()}_WEBHOOK_SECRET`
  return process.env[envKey] || ''
}

function verifySecret(request: NextRequest, providerType: string): boolean {
  const secret = getSecret(providerType)
  if (!secret) return true

  const headerSecret = request.headers.get('x-webhook-secret')
  if (headerSecret === secret) return true

  const { searchParams } = new URL(request.url)
  const querySecret = searchParams.get('secret')
  if (querySecret === secret) return true

  return false
}

export async function POST(request: NextRequest, { params }: { params: { provider: string } }) {
  const providerType = params.provider || 'generic'

  if (!verifySecret(request, providerType)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    let body: any
    const rawText = await request.text()
    try {
      body = JSON.parse(rawText)
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
    }

    const result = await receiveProviderWebhook(providerType, body)

    if (result.duplicate) {
      return NextResponse.json({ success: true, duplicate: true }, { status: 200 })
    }

    return NextResponse.json({
      success: result.success,
      status: result.status,
      eventId: result.eventId,
      error: result.error || undefined,
    }, { status: 200 })
  } catch (error: any) {
    console.error(`[webhook:${providerType}] Error:`, error)
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
  }
}