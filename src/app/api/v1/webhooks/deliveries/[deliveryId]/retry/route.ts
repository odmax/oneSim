import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { deliverWebhook } from '@/lib/services/business-webhooks/dispatcher'

function makeError(code: string, message: string) { return { success: false, error: { code, message } } }

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function POST(request: NextRequest, { params }: { params: { deliveryId: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: params.deliveryId },
      include: { endpoint: true },
    })
    if (!delivery || delivery.businessId !== businessId) return respond(request, makeError('NOT_FOUND', 'Delivery not found'), 404, startTime, businessId, { errorMessage: 'Not found' })

    const success = await deliverWebhook(delivery.id)

    return respond(request, { success, status: success ? 'SENT' : 'FAILED' }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}