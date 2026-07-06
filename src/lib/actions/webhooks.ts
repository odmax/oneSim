'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import crypto from 'crypto'
import { handlePrismaError } from '@/lib/errors/handle-prisma-error'

function generateSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('hex')
}

function generateDeliveryId(): string {
  return 'del_' + crypto.randomBytes(16).toString('hex')
}

function getEventsFromForm(formData: FormData): string[] {
  const events: string[] = []
  const allEvents = [
    'esim.activation.pending',
    'esim.activation.completed',
    'esim.activation.failed',
    'esim.usage.updated',
    'order.created',
    'order.failed',
    'webhook.test',
  ]
  for (const event of allEvents) {
    if (formData.get(event) === 'on') events.push(event)
  }
  return events
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development'
}

function validateUrl(url: string): string | null {
  let parsedUrl: URL
  try { parsedUrl = new URL(url) } catch { return 'Invalid URL format' }

  if (parsedUrl.protocol === 'http:' && parsedUrl.hostname === 'localhost' && isDev()) {
    return null // allow http://localhost in dev
  }

  if (parsedUrl.protocol !== 'https:') return 'URL must use HTTPS in production'
  return null
}

export async function createWebhook(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
  })
  if (!businessUser) redirect('/business/webhooks?error=Only+admins+can+manage+webhooks')

  const name = formData.get('name') as string
  const url = formData.get('url') as string
  const events = getEventsFromForm(formData)

  if (!name || !url || events.length === 0) {
    redirect('/business/webhooks?error=Name,+URL,+and+at+least+one+event+required')
  }

  const urlError = validateUrl(url)
  if (urlError) redirect(`/business/webhooks?error=${encodeURIComponent(urlError)}`)

  const existing = await prisma.businessWebhookEndpoint.findFirst({
    where: { businessId: session.user.businessId!, url },
  })
  if (existing) redirect('/business/webhooks?error=URL+already+configured+for+this+business')

  const secret = generateSecret()

  await prisma.businessWebhookEndpoint.create({
    data: {
      businessId: session.user.businessId!,
      name,
      url,
      secret,
      status: 'ACTIVE',
      events,
    },
  })

  revalidatePath('/business/webhooks')
  redirect(`/business/webhooks?success=Webhook+created&new_secret=${secret}`)
}

export async function updateWebhook(endpointId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
  })
  if (!businessUser) redirect('/business/webhooks?error=Only+admins+can+manage+webhooks')

  const endpoint = await prisma.businessWebhookEndpoint.findFirst({
    where: { id: endpointId, businessId: session.user.businessId! },
  })
  if (!endpoint) redirect('/business/webhooks?error=Webhook+not+found')

  const name = formData.get('name') as string
  const url = formData.get('url') as string
  const events = getEventsFromForm(formData)

  if (!name || !url || events.length === 0) {
    redirect(`/business/webhooks?error=Name,+URL,+and+at+least+one+event+required`)
  }

  const urlError = validateUrl(url)
  if (urlError) redirect(`/business/webhooks?error=${encodeURIComponent(urlError)}`)

  if (url !== endpoint.url) {
    const existing = await prisma.businessWebhookEndpoint.findFirst({
      where: { businessId: session.user.businessId!, url, id: { not: endpointId } },
    })
    if (existing) redirect('/business/webhooks?error=URL+already+configured+for+this+business')
  }

  const regenerateSecret = formData.get('regenerate_secret') === 'on'
  const updateData: any = { name, url, events }
  if (regenerateSecret) updateData.secret = generateSecret()

  const updated = await prisma.businessWebhookEndpoint.update({
    where: { id: endpointId },
    data: updateData,
  })

  revalidatePath('/business/webhooks')
  if (regenerateSecret) {
    redirect(`/business/webhooks?success=Webhook+updated&new_secret=${updated.secret}`)
  }
  redirect('/business/webhooks?success=Webhook+updated')
}

export async function toggleWebhook(endpointId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') return

    const endpoint = await prisma.businessWebhookEndpoint.findFirst({
      where: { id: endpointId, businessId: session.user.businessId! },
    })
    if (!endpoint) return

    const newStatus = endpoint.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await prisma.businessWebhookEndpoint.update({
      where: { id: endpointId },
      data: { status: newStatus },
    })

    revalidatePath('/business/webhooks')
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to toggle webhook')
    console.error('[toggleWebhook]', message)
  }
}

export async function deleteWebhook(endpointId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') return

    const businessUser = await prisma.businessUser.findFirst({
      where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
    })
    if (!businessUser) return

    await prisma.businessWebhookEndpoint.deleteMany({
      where: { id: endpointId, businessId: session.user.businessId! },
    })

    revalidatePath('/business/webhooks')
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to delete webhook')
    console.error('[deleteWebhook]', message)
  }
}

export async function sendTestWebhook(endpointId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
  })
  if (!businessUser) redirect('/business/webhooks?error=Only+admins+can+send+test+webhooks')

  const endpoint = await prisma.businessWebhookEndpoint.findFirst({
    where: { id: endpointId, businessId: session.user.businessId! },
  })
  if (!endpoint) redirect('/business/webhooks?error=Webhook+not+found')

  const deliveryId = generateDeliveryId()
  const timestamp = Math.floor(Date.now() / 1000)

  const testPayload = {
    event: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from OneSIM.',
      endpointId: endpoint.id,
      endpointName: endpoint.name,
    },
  }

  const body = JSON.stringify(testPayload)
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex')

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OneSim-Event': 'webhook.test',
        'X-OneSim-Signature': signature,
        'X-OneSim-Timestamp': String(timestamp),
        'X-OneSim-Delivery-Id': deliveryId,
        'User-Agent': 'OneSim-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(10000),
    })

    const responseBody = await response.text().catch(() => null)

    await prisma.webhookDelivery.create({
      data: {
        businessId: session.user.businessId!,
        endpointId: endpoint.id,
        eventType: 'webhook.test',
        payload: testPayload,
        status: response.ok ? 'SENT' : 'FAILED',
        responseCode: response.status,
        responseBody,
        attempts: 1,
        sentAt: new Date(),
      },
    })

    if (response.ok) {
      revalidatePath('/business/webhooks')
      redirect('/business/webhooks?success=Test+webhook+sent+successfully')
    }

    // Enqueue retry for failed test
    await prisma.backgroundJob.create({
      data: {
        type: 'WEBHOOK_DELIVERY',
        status: 'PENDING',
        payload: {
          endpointId: endpoint.id,
          businessId: session.user.businessId!,
          eventType: 'webhook.test',
          webhookPayload: testPayload,
        },
        runAt: new Date(Date.now() + 60 * 1000),
      },
    }).catch(() => {})

    revalidatePath('/business/webhooks')
    redirect(`/business/webhooks?success=Test+webhook+delivered+but+endpoint+returned+${response.status}`)
  } catch (e: any) {
    const delivery = await prisma.webhookDelivery.create({
      data: {
        businessId: session.user.businessId!,
        endpointId: endpoint.id,
        eventType: 'webhook.test',
        payload: testPayload,
        status: 'FAILED',
        responseBody: e.message || 'Network error',
        attempts: 1,
      },
    })

    // Enqueue retry
    await prisma.backgroundJob.create({
      data: {
        type: 'WEBHOOK_DELIVERY',
        status: 'PENDING',
        payload: {
          endpointId: endpoint.id,
          businessId: session.user.businessId!,
          eventType: 'webhook.test',
          webhookPayload: testPayload,
          deliveryId: delivery.id,
        },
        runAt: new Date(Date.now() + 60 * 1000),
      },
    }).catch(() => {})

    revalidatePath('/business/webhooks')
    redirect(`/business/webhooks?error=${encodeURIComponent('Test webhook failed: ' + (e.message || 'Network error'))}`)
  }
}

export async function getWebhookEndpoints(businessId: string) {
  return prisma.businessWebhookEndpoint.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { deliveries: true } },
    },
  })
}

export async function getWebhookDeliveries(businessId: string, limit = 50) {
  return prisma.webhookDelivery.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      endpoint: { select: { name: true, url: true } },
    },
  })
}

export async function getLastDeliveryForEndpoint(endpointId: string) {
  return prisma.webhookDelivery.findFirst({
    where: { endpointId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      eventType: true,
      status: true,
      responseCode: true,
      attempts: true,
      createdAt: true,
    },
  })
}
