import { prisma } from '@/lib/prisma'
import crypto from 'crypto'
import { enqueueJob } from '@/lib/services/jobs/queue'

function generateDeliveryId(): string {
  return 'del_' + crypto.randomBytes(16).toString('hex')
}

const WEBHOOK_EVENTS = [
  'esim.activation.pending',
  'esim.activation.completed',
  'esim.activation.failed',
  'esim.usage.updated',
  'order.created',
  'order.failed',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

async function getEndpointsForBusiness(businessId: string, eventType: string) {
  const endpoints = await prisma.businessWebhookEndpoint.findMany({
    where: {
      businessId,
      status: 'ACTIVE',
    },
  })
  return endpoints.filter((ep) => {
    const events: string[] = typeof ep.events === 'string' ? JSON.parse(ep.events) : ep.events
    return events.includes(eventType)
  })
}

function signPayload(payload: any, secret: string): string {
  const json = JSON.stringify(payload)
  return crypto.createHmac('sha256', secret).update(json).digest('hex')
}

function getCallbackUrl(purchase: any): string | null {
  if (purchase.callbackUrl) return purchase.callbackUrl
  return null
}

async function deliverToEndpoint(
  endpoint: { id: string; businessId: string; url: string; secret: string; name: string },
  eventType: string,
  payload: any,
) {
  const deliveryId = generateDeliveryId()
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signPayload(payload, endpoint.secret)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-OneSim-Event': eventType,
    'X-OneSim-Signature': signature,
    'X-OneSim-Timestamp': String(timestamp),
    'X-OneSim-Delivery-Id': deliveryId,
    'User-Agent': 'OneSim-Webhook/1.0',
  }

  let responseCode: number | null = null
  let responseBody: string | null = null
  let status: 'SENT' | 'FAILED' = 'SENT'

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    responseCode = response.status
    responseBody = await response.text().catch(() => null)
    if (!response.ok) status = 'FAILED'
  } catch (error: any) {
    status = 'FAILED'
    responseBody = error.message || 'Connection failed'
  }

  const delivery = await prisma.webhookDelivery.create({
    data: {
      businessId: endpoint.businessId,
      endpointId: endpoint.id,
      eventType,
      payload: payload as any,
      status,
      responseCode,
      responseBody,
      attempts: 1,
      sentAt: new Date(),
    },
  })

  // Enqueue retry job if delivery failed
  if (status === 'FAILED') {
    enqueueJob(
      'WEBHOOK_DELIVERY',
      {
        endpointId: endpoint.id,
        businessId: endpoint.businessId,
        eventType,
        webhookPayload: payload,
        deliveryId: delivery.id,
      },
      new Date(Date.now() + 60 * 1000), // 1 minute first retry
    ).catch(() => {})
  }

  return { status, responseCode, responseBody }
}

async function deliverToCallbackUrl(
  businessId: string,
  callbackUrl: string,
  eventType: string,
  payload: any,
) {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signPayload(payload, 'onesim-callback')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-OneSim-Event': eventType,
    'X-OneSim-Signature': signature,
    'X-OneSim-Timestamp': String(timestamp),
    'User-Agent': 'OneSim-Webhook/1.0',
  }

  let responseCode: number | null = null
  let responseBody: string | null = null

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    responseCode = response.status
    responseBody = await response.text().catch(() => null)
  } catch (error: any) {
    responseBody = error.message || 'Connection failed'
  }

  return { responseCode, responseBody }
}

export async function sendWebhook(
  eventType: WebhookEvent,
  businessId: string,
  payload: any,
) {
  const endpoints = await getEndpointsForBusiness(businessId, eventType)
  const results: any[] = []

  for (const endpoint of endpoints) {
    const result = await deliverToEndpoint(endpoint, eventType, payload)
    results.push({ endpointId: endpoint.id, endpointName: endpoint.name, ...result })
  }

  return { delivered: results.length, results }
}

export async function sendWebhookForPurchase(
  eventType: WebhookEvent,
  purchaseId: string,
  extraPayload: Record<string, any> = {},
) {
  const purchase = await prisma.eSIMPurchase.findUnique({
    where: { id: purchaseId },
    include: {
      business: { select: { id: true } },
      package: true,
      esims: true,
    },
  })

  if (!purchase) return

  const payload: Record<string, any> = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: {
      orderId: purchase.id,
      status: purchase.status,
      packageName: purchase.package.name,
      quantity: purchase.quantity,
      totalAmount: purchase.totalAmount.toString(),
      esims: purchase.esims.map((e) => ({
        iccid: e.iccid,
        status: e.status,
      })),
      ...extraPayload,
    },
  }

  // Send to configured webhook endpoints
  await sendWebhook(eventType, purchase.business.id, payload)

  // Send to order-specific callbackUrl if present
  if (purchase.callbackUrl) {
    await deliverToCallbackUrl(purchase.business.id, purchase.callbackUrl, eventType, payload)
  }
}
