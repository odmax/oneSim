export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { signCallbackPayload, getCallbackSecret, validateCallbackUrl, classifyCallbackResponse, getCallbackRetryDelay } from '@/lib/services/orders/callback-delivery'

async function deliverOne(delivery: any): Promise<{ success: boolean; status: string }> {
  const batchSize = parseInt(process.env.ORDER_CALLBACK_BATCH_SIZE || '50', 10)
  const timeoutMs = parseInt(process.env.ORDER_CALLBACK_TIMEOUT_MS || '10000', 10)

  if (delivery.status === 'DELIVERED' || delivery.status === 'DEAD_LETTERED') {
    return { success: true, status: 'SKIPPED' }
  }

  const urlCheck = validateCallbackUrl(delivery.callbackUrl)
  if (!urlCheck.valid) {
    await prisma.orderCallbackDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', lastErrorCode: 'INVALID_URL', lastErrorMessage: urlCheck.reason },
    })
    return { success: false, status: 'INVALID_URL' }
  }

  const body = JSON.stringify(delivery.payload)
  const secret = getCallbackSecret(delivery.businessId)
  const signature = signCallbackPayload(body, secret)
  const timestamp = String(Date.now())

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(delivery.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OneSIM-Event-Id': delivery.eventId,
        'X-OneSIM-Event-Type': delivery.eventType,
        'X-OneSIM-Timestamp': timestamp,
        'X-OneSIM-Signature': `v1=${signature}`,
        'User-Agent': 'OneSIM-Webhook/1.0',
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    const classification = classifyCallbackResponse(res.status)
    const attemptCount = (delivery.attemptCount || 0) + 1

    if (classification === 'success') {
      await prisma.orderCallbackDelivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), attemptCount, lastHttpStatus: res.status, lastAttemptAt: new Date(), nextAttemptAt: null },
      })
      return { success: true, status: 'DELIVERED' }
    }

    if (classification === 'retryable' && attemptCount < (delivery.maxAttempts || 7)) {
      const delay = getCallbackRetryDelay(attemptCount)
      await prisma.orderCallbackDelivery.update({
        where: { id: delivery.id },
        data: { status: 'RETRY_SCHEDULED', attemptCount, lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + delay), lastHttpStatus: res.status, lastErrorCode: `HTTP_${res.status}` },
      })
      return { success: false, status: 'RETRY_SCHEDULED' }
    }

    await prisma.orderCallbackDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DEAD_LETTERED', attemptCount, lastAttemptAt: new Date(), lastHttpStatus: res.status, lastErrorCode: `HTTP_${res.status}` },
    })
    return { success: false, status: 'DEAD_LETTERED' }
  } catch (e: any) {
    const attemptCount = (delivery.attemptCount || 0) + 1
    const isTimeout = e.name === 'AbortError'
    if (attemptCount < (delivery.maxAttempts || 7)) {
      const delay = getCallbackRetryDelay(attemptCount)
      await prisma.orderCallbackDelivery.update({
        where: { id: delivery.id },
        data: { status: 'RETRY_SCHEDULED', attemptCount, lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + delay), lastErrorCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR', lastErrorMessage: e.message?.substring(0, 200) },
      })
      return { success: false, status: 'RETRY_SCHEDULED' }
    }
    await prisma.orderCallbackDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DEAD_LETTERED', attemptCount, lastAttemptAt: new Date(), lastErrorCode: isTimeout ? 'TIMEOUT' : 'MAX_ATTEMPTS' },
    })
    return { success: false, status: 'DEAD_LETTERED' }
  }
}

export async function POST(req: NextRequest) {
  const enabled = process.env.OUTBOUND_CALLBACKS_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Disabled' }, { status: 403 })

  const secret = process.env.ORDER_CALLBACK_JOB_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (!auth || auth !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const lock = await prisma.systemJobLock.upsert({
    where: { jobName: 'order-callback-delivery' },
    create: { jobName: 'order-callback-delivery', lockedAt: new Date(), lockedUntil: new Date(Date.now() + 600000), owner: `cb-${process.pid}` },
    update: { lockedAt: new Date(), lockedUntil: new Date(Date.now() + 600000), owner: `cb-${process.pid}` },
  }).catch(() => null)
  if (!lock) return NextResponse.json({ error: 'Lock failed' }, { status: 409 })

  const batchSize = parseInt(process.env.ORDER_CALLBACK_BATCH_SIZE || '50', 10)
  const pending = await prisma.orderCallbackDelivery.findMany({
    where: { status: { in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { lte: new Date() } },
    take: batchSize,
    orderBy: { nextAttemptAt: 'asc' },
  })

  let delivered = 0, retryScheduled = 0, deadLettered = 0, skipped = 0, failed = 0
  for (const d of pending) {
    try {
      const r = await deliverOne(d)
      if (r.status === 'DELIVERED') delivered++
      else if (r.status === 'RETRY_SCHEDULED') retryScheduled++
      else if (r.status === 'DEAD_LETTERED') deadLettered++
      else if (r.status === 'SKIPPED') skipped++
    } catch { failed++ }
  }

  return NextResponse.json({ scanned: pending.length, delivered, retryScheduled, deadLettered, skipped, failed })
}
