import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

export async function retryWebhookDelivery(
  endpointId: string,
  businessId: string,
  eventType: string,
  webhookPayload: any,
  deliveryId?: string,
) {
  const endpoint = await prisma.businessWebhookEndpoint.findUnique({
    where: { id: endpointId },
  })

  if (!endpoint || endpoint.status !== 'ACTIVE') {
    return { completed: false, error: 'Endpoint not found or inactive' }
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const json = JSON.stringify(webhookPayload)
  const signature = crypto.createHmac('sha256', endpoint.secret).update(json).digest('hex')

  let responseCode: number | null = null
  let responseBody: string | null = null
  let success = false

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OneSim-Event': eventType,
        'X-OneSim-Signature': signature,
        'X-OneSim-Timestamp': String(timestamp),
        'User-Agent': 'OneSim-Webhook/1.0',
      },
      body: json,
      signal: AbortSignal.timeout(15000),
    })
    responseCode = response.status
    responseBody = await response.text().catch(() => null)
    success = response.ok
  } catch (error: any) {
    responseBody = error.message || 'Connection failed'
  }

  // Update the original delivery record if we have its id
  if (deliveryId) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: success ? 'SENT' : 'FAILED',
        responseCode,
        responseBody,
        attempts: { increment: 1 },
        sentAt: success ? new Date() : undefined,
      },
    })
  }

  return { completed: success, error: success ? undefined : `HTTP ${responseCode}: ${responseBody}` }
}
