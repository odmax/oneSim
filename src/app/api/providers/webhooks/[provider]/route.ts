import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processProviderWebhook } from '@/lib/services/webhooks/provider-webhook-service'
import type { NormalizedWebhookEvent } from '@/lib/services/webhooks/provider-webhook-service'

export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerCode } = await params
  const startTime = Date.now()

  // Find provider
  const provider = await prisma.provider.findFirst({
    where: { code: providerCode.toUpperCase(), status: { not: 'ARCHIVED' } },
  })
  if (!provider) {
    return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 })
  }

  // Read raw body for signature verification
  const rawBody = await request.text()

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalize the event using the existing provider-specific normalizer
  let event: NormalizedWebhookEvent
  try {
    // Use CHOICE normalizer if available, otherwise generic
    if (providerCode.toUpperCase() === 'CHOICE') {
      const { normalizeChoiceWebhook } = await import('@/lib/providers/webhooks/choice-webhook-normalizer')
      const normalized = normalizeChoiceWebhook(payload)
      event = {
        eventId: normalized.externalEventId,
        eventType: normalized.eventType,
        status: mapToWebhookStatus(normalized.eventType),
        providerReference: normalized.iccid || normalized.imsi || undefined,
        iccids: normalized.iccid ? [normalized.iccid] : undefined,
      }
    } else {
      // Generic normalization
      event = {
        eventId: payload.eventId || payload.id || payload.event_id,
        eventType: payload.eventType || payload.event || 'UNKNOWN',
        status: payload.status as any || 'PENDING',
        providerReference: payload.providerReference || payload.orderReference || payload.iccid,
        iccids: payload.iccids || (payload.iccid ? [payload.iccid] : undefined),
        errorCode: payload.errorCode || payload.code,
        errorMessage: payload.errorMessage || payload.message,
        raw: payload,
      }
    }
  } catch (error: any) {
    console.log(`[WEBHOOK] provider=${providerCode} error=normalization_failed message=${error.message?.substring(0, 200)}`)
    return NextResponse.json({ success: false, error: 'Event normalization failed' }, { status: 422 })
  }

  console.log(`[WEBHOOK] provider=${providerCode} eventType=${event.eventType} status=${event.status} ref=${event.providerReference || 'none'}`)

  // Process the webhook
  const result = await processProviderWebhook(provider.id, event)

  console.log(`[WEBHOOK] provider=${providerCode} result=${result.status} matched=${result.matched} durationMs=${Date.now() - startTime}`)

  return NextResponse.json({ success: true, status: result.status })
}

function mapToWebhookStatus(eventType: string): NormalizedWebhookEvent['status'] {
  switch (eventType) {
    case 'ESIM_ACTIVATED': return 'COMPLETED'
    case 'ESIM_EXPIRED': return 'FAILED'
    case 'ESIM_SUSPENDED': return 'CANCELLED'
    default: return 'PENDING'
  }
}
