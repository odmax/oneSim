import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import AdminWebhookMonitor from './AdminWebhookMonitor'

export default async function WebhookMonitoringPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [endpoints, totalDeliveries, todayDeliveries, todaySuccess, todayFailed, pendingRetries] = await Promise.all([
    prisma.businessWebhookEndpoint.findMany({
      orderBy: [{ lastFailureAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: {
        business: { select: { id: true, name: true } },
        _count: { select: { deliveries: true } },
      },
    }),
    prisma.webhookDelivery.count(),
    prisma.webhookDelivery.count({ where: { createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { status: 'SENT', createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { status: { in: ['PENDING', 'FAILED'] }, nextRetryAt: { not: null } } }),
  ])

  const businessesWithFailures = new Set(endpoints.filter(e => e.failureCount > 0).map(e => e.business?.name)).size
  const topFailing = endpoints.filter(e => e.failureCount > 0).sort((a, b) => b.failureCount - a.failureCount).slice(0, 5)

  const metrics = {
    totalEndpoints: endpoints.length,
    activeEndpoints: endpoints.filter(e => e.status === 'ACTIVE').length,
    totalDeliveries,
    todayDeliveries,
    todaySuccess,
    todayFailed,
    pendingRetries,
    successRate: todayDeliveries > 0 ? Math.round((todaySuccess / todayDeliveries) * 100) : null,
    businessesWithFailures,
    topFailing: JSON.parse(JSON.stringify(topFailing.map(e => ({ id: e.id, name: e.name, url: e.url, businessName: e.business?.name, failureCount: e.failureCount, status: e.status, lastFailureAt: e.lastFailureAt, lastSuccessAt: e.lastSuccessAt, events: e.events })))),
  }

  return <AdminWebhookMonitor endpoints={JSON.parse(JSON.stringify(endpoints.map(e => ({ id: e.id, name: e.name, url: e.url, status: e.status, events: e.events, failureCount: e.failureCount, lastSuccessAt: e.lastSuccessAt, lastFailureAt: e.lastFailureAt, deliveryCount: e._count.deliveries, business: { id: e.business?.id, name: e.business?.name || 'Unknown' } }))))} metrics={metrics} />
}