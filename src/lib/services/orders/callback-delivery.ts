import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

// ─────────────────────────────────────────────
// Event creation (Task 5)
// ─────────────────────────────────────────────

export type OrderEventType =
  | 'order.created'
  | 'order.processing'
  | 'order.partially_fulfilled'
  | 'order.fulfilled'
  | 'order.reconciliation_required'
  | 'order.failover_started'
  | 'order.failed'
  | 'order.cancelled'
  | 'order.refunded'
  | 'webhook.test'

export const ORDER_EVENT_TYPES: OrderEventType[] = [
  'order.created', 'order.processing', 'order.partially_fulfilled', 'order.fulfilled',
  'order.reconciliation_required', 'order.failover_started',
  'order.failed', 'order.cancelled', 'order.refunded', 'webhook.test',
]

/**
 * Enqueue a callback delivery for an order event.
 * Order without callbackUrl is silently skipped.
 * Idempotent by eventId = `${orderId}:${eventType}:${version}`.
 */
export async function enqueueOrderCallback(params: {
  orderId: string
  businessId: string
  eventType: OrderEventType
  data: Record<string, any>
  version?: number
}): Promise<{ enqueued: boolean; deliveryId?: string }> {
  const { orderId, businessId, eventType, data, version = 1 } = params
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    select: { callbackUrl: true, status: true, quantity: true, fulfilledQuantity: true, totalAmount: true, quotedTotalAmount: true, quotedCurrency: true, packageCurrency: true },
  })
  if (!order?.callbackUrl) return { enqueued: false }

  const eventId = `cb:${orderId}:${eventType}:v${version}`

  // Idempotency
  const existing = await prisma.orderCallbackDelivery.findUnique({ where: { eventId } })
  if (existing) return { enqueued: false, deliveryId: existing.id }

  // Build safe payload
  const payload = {
    id: eventId, type: eventType, createdAt: new Date().toISOString(), businessId,
    data: {
      orderId, status: order.status, quantity: order.quantity,
      fulfilledQuantity: order.fulfilledQuantity ?? 0,
      amount: Number(order.quotedTotalAmount ?? order.totalAmount ?? 0).toFixed(2),
      currency: order.quotedCurrency || order.packageCurrency || 'USD',
      ...data,
    },
  }

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  try {
    const delivery = await prisma.orderCallbackDelivery.create({
      data: {
        orderId, businessId, eventType, eventId,
        callbackUrl: order.callbackUrl,
        payload: payload as any,
        payloadHash,
        status: 'PENDING',
        nextAttemptAt: new Date(),
        maxAttempts: parseInt(process.env.ORDER_CALLBACK_MAX_ATTEMPTS || '7', 10),
      },
    })
    return { enqueued: true, deliveryId: delivery.id }
  } catch (e: any) {
    if (e.code === 'P2002' || /unique.*eventId/i.test(e.message || '')) {
      return { enqueued: false }
    }
    return { enqueued: false }
  }
}

// ─────────────────────────────────────────────
// URL validation + SSRF protection (Task 6)
// ─────────────────────────────────────────────

const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254']
const BLOCKED_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '169.254.']

export function validateCallbackUrl(url: string): { valid: boolean; reason?: string } {
  if (!url) return { valid: false, reason: 'URL is required' }
  try {
    const parsed = new URL(url)
    if (process.env.OUTBOUND_CALLBACK_ALLOW_HTTP !== 'true' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Only HTTPS allowed in production' }
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) return { valid: false, reason: 'Invalid protocol' }
    const host = parsed.hostname.toLowerCase()
    if (BLOCKED_HOSTS.includes(host)) return { valid: false, reason: 'Blocked hostname' }
    if (host === '[::1]' || host === '0:0:0:0:0:0:0:1') return { valid: false, reason: 'IPv6 loopback blocked' }
    for (const prefix of BLOCKED_PREFIXES) {
      if (host.startsWith(prefix)) return { valid: false, reason: 'Private network blocked' }
    }
    return { valid: true }
  } catch {
    return { valid: false, reason: 'Invalid URL format' }
  }
}

// ─────────────────────────────────────────────
// HMAC signing (Task 7)
// ─────────────────────────────────────────────

export function signCallbackPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

export function getCallbackSecret(businessId: string): string {
  return process.env.CALLBACK_SIGNING_SECRET || `onesim-callback-${businessId}`
}

// ─────────────────────────────────────────────
// Delivery retry delays
// ─────────────────────────────────────────────

const CALLBACK_RETRY_DELAYS = [0, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]

export function getCallbackRetryDelay(attempt: number): number {
  const idx = Math.min(Math.max(0, attempt - 1), CALLBACK_RETRY_DELAYS.length - 1)
  return CALLBACK_RETRY_DELAYS[idx]
}

// ─────────────────────────────────────────────
// Delivery classification
// ─────────────────────────────────────────────

export function classifyCallbackResponse(status: number): 'success' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'success'
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return 'retryable'
  return 'permanent'
}
