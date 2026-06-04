import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

const EVENT_TYPES = [
  'order.completed',
  'order.failed',
  'esim.provisioned',
  'esim.activated',
  'esim.expired',
  'esim.suspended',
  'usage.updated',
  'topup.completed',
  'topup.failed',
  'wallet.low_balance',
] as const

export type WebhookEventType = typeof EVENT_TYPES[number]

function generateEventId(): string {
  return `evt_${crypto.randomBytes(16).toString('hex')}`
}

function signPayload(secret: string, timestamp: number, body: string): string {
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(`${timestamp}.${body}`)
  return hmac.digest('hex')
}

export interface WebhookPayload {
  id: string
  type: string
  createdAt: string
  businessId: string
  data: any
}

export async function enqueueBusinessWebhooks(businessId: string, eventType: WebhookEventType, data: any) {
  const endpoints = await prisma.businessWebhookEndpoint.findMany({
    where: {
      businessId,
      status: 'ACTIVE',
    },
  })

  const eventId = generateEventId()
  const createdAt = new Date().toISOString()

  const payload: WebhookPayload = {
    id: eventId,
    type: eventType,
    createdAt,
    businessId,
    data,
  }

  for (const endpoint of endpoints) {
    const events = endpoint.events as string[]
    if (!events.includes('*') && !events.includes(eventType)) continue

    await prisma.webhookDelivery.create({
      data: {
        businessId,
        endpointId: endpoint.id,
        eventType,
        eventId,
        payload: payload as any,
        status: 'PENDING',
        attempts: 0,
      },
    })
  }
}

export async function deliverWebhook(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  })
  if (!delivery || delivery.endpoint.status !== 'ACTIVE') return false

  const payloadStr = JSON.stringify(delivery.payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signPayload(delivery.endpoint.secret, timestamp, payloadStr)

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(delivery.endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OneSim-Event': delivery.eventType,
        'X-OneSim-Event-Id': delivery.eventId || '',
        'X-OneSim-Timestamp': String(timestamp),
        'X-OneSim-Signature': signature,
        'User-Agent': 'OneSim-Webhook/1.0',
      },
      body: payloadStr,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    const responseBody = await response.text()
    const success = response.status >= 200 && response.status < 300

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: success ? 'SENT' : 'FAILED',
        responseCode: response.status,
        responseBody: responseBody.substring(0, 2000),
        attempts: { increment: 1 },
        sentAt: success ? new Date() : undefined,
        errorMessage: success ? null : `HTTP ${response.status}`,
        nextRetryAt: success ? null : calculateNextRetry(delivery.attempts + 1),
      },
    })

    // Update endpoint stats
    if (success) {
      await prisma.businessWebhookEndpoint.update({
        where: { id: delivery.endpointId },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      })
    } else {
      await prisma.businessWebhookEndpoint.update({
        where: { id: delivery.endpointId },
        data: { lastFailureAt: new Date(), failureCount: { increment: 1 } },
      })
    }

    return success
  } catch (error: any) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: delivery.attempts + 1 >= 5 ? 'FAILED' : 'PENDING',
        attempts: { increment: 1 },
        errorMessage: error.message?.substring(0, 500) || 'Connection failed',
        nextRetryAt: delivery.attempts + 1 < 5 ? calculateNextRetry(delivery.attempts + 1) : null,
      },
    })

    await prisma.businessWebhookEndpoint.update({
      where: { id: delivery.endpointId },
      data: {
        lastFailureAt: new Date(),
        failureCount: { increment: 1 },
      },
    }).catch(() => {})

    return false
  }
}

function calculateNextRetry(attempt: number): Date {
  const delays = [60, 300, 900, 3600]
  const delay = delays[attempt - 1] || 3600
  return new Date(Date.now() + delay * 1000)
}

export async function processPendingWebhookDeliveries(): Promise<{ sent: number; failed: number }> {
  const deliveries = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: new Date() } },
      ],
      endpoint: { status: 'ACTIVE' },
    },
    include: { endpoint: true },
    take: 50,
  })

  let sent = 0
  let failed = 0

  for (const delivery of deliveries) {
    const success = await deliverWebhook(delivery.id)
    if (success) sent++
    else failed++
  }

  return { sent, failed }
}