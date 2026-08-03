export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

// ─────────────────────────────────────────────
// Authentication strategy
// ─────────────────────────────────────────────

async function authenticateWebhook(req: NextRequest, provider: any): Promise<{ ok: boolean; error?: string }> {
  const config = (provider.config as any) || {}
  const webhookAuth = config.webhookAuth || {}

  // Strategy 1: IP whitelist
  if (webhookAuth.ipWhitelist?.length) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (!webhookAuth.ipWhitelist.includes(ip)) {
      return { ok: false, error: `IP ${ip} not whitelisted` }
    }
  }

  // Strategy 2: Bearer token
  if (webhookAuth.bearerToken) {
    const auth = req.headers.get('authorization') || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(webhookAuth.bearerToken))) {
      return { ok: false, error: 'Invalid bearer token' }
    }
    return { ok: true }
  }

  // Strategy 3: HMAC signature
  if (webhookAuth.hmacSecret) {
    const signature = req.headers.get('x-signature') || req.headers.get('x-hub-signature-256') || ''
    const body = await req.clone().text()
    const expected = crypto.createHmac('sha256', webhookAuth.hmacSecret).update(body).digest('hex')
    const expectedPrefixed = `sha256=${expected}`
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedPrefixed))) {
      return { ok: false, error: 'Invalid HMAC signature' }
    }
    return { ok: true }
  }

  // Strategy 4: API key header
  if (webhookAuth.apiKey) {
    const key = req.headers.get('x-api-key') || ''
    if (!crypto.timingSafeEqual(Buffer.from(key), Buffer.from(webhookAuth.apiKey))) {
      return { ok: false, error: 'Invalid API key' }
    }
    return { ok: true }
  }

  // Strategy 5: Timestamp validation (anti-replay)
  if (webhookAuth.maxAgeSeconds) {
    const ts = req.headers.get('x-timestamp')
    if (ts) {
      const delta = Math.abs(Date.now() - new Date(ts).getTime()) / 1000
      if (delta > webhookAuth.maxAgeSeconds) {
        return { ok: false, error: `Timestamp too old: ${delta}s > ${webhookAuth.maxAgeSeconds}s` }
      }
    }
  }

  // No auth configured — accept for development
  if (provider.environment !== 'production' && Object.keys(webhookAuth).length === 0) {
    return { ok: true }
  }

  return { ok: false, error: 'No webhook authentication configured' }
}

// ─────────────────────────────────────────────
// POST /api/providers/webhooks/[provider]
// ─────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: { params: { provider: string } }) {
  const providerCode = params.provider.toUpperCase()

  const provider = await prisma.provider.findFirst({
    where: { code: providerCode, status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] } },
  })
  if (!provider) {
    return NextResponse.json({ error: 'Provider not found or inactive' }, { status: 404 })
  }

  // Authenticate
  const auth = await authenticateWebhook(req, provider)
  if (!auth.ok) {
    console.log(`[WEBHOOK_AUTH_FAIL] provider=${providerCode} error=${auth.error}`)
    return NextResponse.json({ error: auth.error }, { status: 401 })
  }

  // Parse payload
  let payload: any
  try {
    payload = await req.json()
  } catch {
    const text = await req.text().catch(() => '')
    payload = { raw: text }
  }

  // Extract event ID for idempotency
  const eventId = payload.event_id || payload.id || payload.externalEventId || payload.eventId || ''
  const computedId = `${providerCode}:${eventId || crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')}`

  // Check duplicate
  if (eventId) {
    const existing = await prisma.providerWebhookEvent.findFirst({
      where: { providerType: providerCode, externalEventId: eventId },
    })
    if (existing && existing.status !== 'FAILED') {
      return NextResponse.json({ status: 'DUPLICATE', eventId: existing.id }, { status: 200 })
    }
  }

  // Sanitize headers
  const safeHeaders: Record<string, string> = {}
  for (const [k, v] of req.headers.entries()) {
    if (!['authorization', 'cookie', 'x-api-key', 'x-signature'].includes(k.toLowerCase())) {
      safeHeaders[k] = v
    }
  }

  // Persist
  const event = await prisma.providerWebhookEvent.create({
    data: {
      providerType: providerCode,
      eventType: payload.event || payload.type || 'RECEIVED',
      externalEventId: eventId || null,
      iccid: payload.iccid || null,
      imsi: payload.imsi || null,
      status: 'RECEIVED',
      payload: {
        body: payload,
        headers: safeHeaders,
        receivedAt: new Date().toISOString(),
      },
      receivedAt: new Date(),
    },
  })

  // Process asynchronously (fire-and-forget)
  const { processProviderWebhook } = await import('@/lib/services/webhooks/provider-webhook-service')
  const { normalizeProviderWebhook } = await import('@/lib/services/webhooks/provider-webhook-processor')

  const normalized = normalizeProviderWebhook(providerCode, payload)
  processProviderWebhook(provider.id, {
    eventId: computedId,
    eventType: normalized.eventType || 'RECEIVED',
    status: normalized.providerStatus === 'active' || normalized.providerStatus === 'completed'
      ? 'COMPLETED' : normalized.providerStatus === 'failed' || normalized.providerStatus === 'error'
        ? 'FAILED' : 'PENDING' as any,
    providerReference: payload.orderReference || payload.reference || eventId || undefined,
    iccids: [normalized.iccid].filter(Boolean) as string[],
    raw: payload,
  }).catch(() => {})

  // Update processing status
  await prisma.providerWebhookEvent.update({
    where: { id: event.id },
    data: { status: 'PROCESSED', processedAt: new Date() },
  }).catch(() => {})

  return NextResponse.json({ status: 'RECEIVED', eventId: event.id }, { status: 200 })
}

export async function GET(req: NextRequest, { params }: { params: { provider: string } }) {
  const providerCode = params.provider.toUpperCase()

  const recent = await prisma.providerWebhookEvent.findMany({
    where: { providerType: providerCode },
    orderBy: { receivedAt: 'desc' },
    take: 50,
    select: { id: true, eventType: true, status: true, externalEventId: true, receivedAt: true },
  })

  return NextResponse.json({ provider: providerCode, recentEvents: recent.length, events: recent })
}
