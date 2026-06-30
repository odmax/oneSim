import { prisma } from '@/lib/prisma'
import { enqueueBusinessWebhooks } from '@/lib/services/business-webhooks/dispatcher'

export type NotificationEventType =
  | 'order.created'
  | 'order.payment_reserved'
  | 'order.provider_accepted'
  | 'order.fulfilled'
  | 'order.failed'
  | 'order.refunded'
  | 'esim.qr_ready'
  | 'esim.installation_pending'
  | 'esim.activated'
  | 'esim.usage_low'
  | 'esim.expired'
  | 'topup.completed'
  | 'topup.failed'
  | 'wallet.low_balance'
  | 'wallet.transaction.created'
  | 'invoice.created'
  | 'provider.degraded'
  | 'provider.offline'
  | 'provider.sync_failed'
  | 'webhook.delivery_failed'

const NOTIFICATION_EVENTS: Record<NotificationEventType, { severity: 'info' | 'warning' | 'error' | 'success'; description: string; webhookEvent?: string }> = {
  'order.created': { severity: 'info', description: 'Order created', webhookEvent: 'order.completed' },
  'order.payment_reserved': { severity: 'info', description: 'Payment reserved for order' },
  'order.provider_accepted': { severity: 'info', description: 'Provider accepted order' },
  'order.fulfilled': { severity: 'success', description: 'Order fulfilled', webhookEvent: 'order.completed' },
  'order.failed': { severity: 'error', description: 'Order failed', webhookEvent: 'order.failed' },
  'order.refunded': { severity: 'info', description: 'Order refunded' },
  'esim.qr_ready': { severity: 'success', description: 'QR code ready', webhookEvent: 'esim.provisioned' },
  'esim.installation_pending': { severity: 'info', description: 'eSIM pending installation' },
  'esim.activated': { severity: 'success', description: 'eSIM activated', webhookEvent: 'esim.activated' },
  'esim.usage_low': { severity: 'warning', description: 'eSIM usage low', webhookEvent: 'usage.updated' },
  'esim.expired': { severity: 'warning', description: 'eSIM expired', webhookEvent: 'esim.expired' },
  'topup.completed': { severity: 'success', description: 'Top-up completed', webhookEvent: 'topup.completed' },
  'topup.failed': { severity: 'error', description: 'Top-up failed', webhookEvent: 'topup.failed' },
  'wallet.low_balance': { severity: 'warning', description: 'Low wallet balance', webhookEvent: 'wallet.low_balance' },
  'wallet.transaction.created': { severity: 'info', description: 'Wallet transaction created' },
  'invoice.created': { severity: 'info', description: 'Invoice created' },
  'provider.degraded': { severity: 'warning', description: 'Provider degraded' },
  'provider.offline': { severity: 'error', description: 'Provider offline' },
  'provider.sync_failed': { severity: 'error', description: 'Provider sync failed' },
  'webhook.delivery_failed': { severity: 'error', description: 'Webhook delivery failed' },
}

export async function emitNotification(eventType: NotificationEventType, context: {
  businessId?: string
  orderId?: string
  esimId?: string
  providerId?: string
  userId?: string
  data?: Record<string, any>
}) {
  const config = NOTIFICATION_EVENTS[eventType]
  if (!config) return

  // Create notification audit log
  await prisma.auditLog.create({
    data: {
      userId: context.userId || null,
      action: `NOTIFICATION_${eventType.toUpperCase().replace(/\./g, '_')}`,
      entity: eventType.startsWith('order.') ? 'ESIMPurchase' : eventType.startsWith('esim.') ? 'ESIM' : eventType.startsWith('provider.') ? 'Provider' : 'System',
      entityId: context.orderId || context.esimId || context.providerId || null,
      details: JSON.stringify({ eventType, ...context.data }),
    },
  }).catch(() => {})

  // Enqueue business webhook if applicable
  if (config.webhookEvent && context.businessId) {
    try {
      await enqueueBusinessWebhooks(context.businessId, config.webhookEvent as any, {
        orderId: context.orderId,
        esimId: context.esimId,
        ...context.data,
      })
    } catch {}
  }
}

export async function getRecentNotifications(limit: number = 50): Promise<Array<{
  id: string
  eventType: NotificationEventType
  severity: string
  description: string
  entity: string
  entityId: string | null
  details: string
  createdAt: Date
}>> {
  const logs = await prisma.auditLog.findMany({
    where: { action: { startsWith: 'NOTIFICATION_' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return logs.map(log => {
    const eventType = log.action.replace('NOTIFICATION_', '').toLowerCase().replace(/_/g, '.') as NotificationEventType
    const config = NOTIFICATION_EVENTS[eventType] || { severity: 'info', description: log.action }
    return {
      id: log.id,
      eventType,
      severity: config.severity,
      description: config.description,
      entity: log.entity,
      entityId: log.entityId,
      details: log.details || '',
      createdAt: log.createdAt,
    }
  })
}

export async function getAlertCounts(): Promise<{ total: number; errors: number; warnings: number }> {
  const recent = await prisma.auditLog.findMany({
    where: { action: { startsWith: 'NOTIFICATION_' }, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    select: { action: true },
  })

  let errors = 0
  let warnings = 0

  for (const log of recent) {
    const eventType = log.action.replace('NOTIFICATION_', '').toLowerCase().replace(/_/g, '.') as NotificationEventType
    const config = NOTIFICATION_EVENTS[eventType]
    if (config?.severity === 'error') errors++
    else if (config?.severity === 'warning') warnings++
  }

  return { total: recent.length, errors, warnings }
}
