import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { getAppUrl } from '@/lib/config/urls'
import WebhooksClient from './WebhooksClient'

export default async function WebhooksPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const webhooks = await prisma.businessWebhookEndpoint.findMany({
    where: { businessId: session.user.businessId! },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, url: true, status: true, events: true,
      lastSuccessAt: true, lastFailureAt: true, failureCount: true, createdAt: true,
    },
  })

  const baseUrl = getAppUrl()

  return <WebhooksClient webhooks={JSON.parse(JSON.stringify(webhooks))} baseUrl={baseUrl} />
}