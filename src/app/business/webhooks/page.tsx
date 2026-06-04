import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { getAppUrl } from '@/lib/config/urls'
import WebhooksClient from './WebhooksClient'

export default async function WebhooksPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!

  const webhooks = await prisma.businessWebhookEndpoint.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, url: true, status: true, events: true,
      lastSuccessAt: true, lastFailureAt: true, failureCount: true, createdAt: true,
    },
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [totalDeliveries, todayDeliveries, todaySuccess, todayFailed, pendingRetries] = await Promise.all([
    prisma.webhookDelivery.count({ where: { businessId } }),
    prisma.webhookDelivery.count({ where: { businessId, createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { businessId, status: 'SENT', createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { businessId, status: 'FAILED', createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { businessId, status: { in: ['PENDING', 'FAILED'] }, nextRetryAt: { not: null } } }),
  ])

  const metrics = {
    totalEndpoints: webhooks.length,
    activeEndpoints: webhooks.filter(w => w.status === 'ACTIVE').length,
    totalDeliveries,
    todayDeliveries,
    todaySuccess,
    todayFailed,
    pendingRetries,
    successRate: todayDeliveries > 0 ? Math.round((todaySuccess / todayDeliveries) * 100) : null,
    lastSuccessfulDelivery: await prisma.webhookDelivery.findFirst({ where: { businessId, status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, eventType: true } }),
    lastFailedDelivery: await prisma.webhookDelivery.findFirst({ where: { businessId, status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, eventType: true, errorMessage: true } }),
  }

  const baseUrl = getAppUrl()

  return <WebhooksClient webhooks={JSON.parse(JSON.stringify(webhooks))} metrics={metrics} baseUrl={baseUrl} />
}