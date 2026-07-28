export const dynamic = 'force-dynamic';

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

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const webhook = await prisma.businessWebhookEndpoint.findFirst({ where: { id: params.id, businessId } })
    if (!webhook) return respond(request, makeError('NOT_FOUND', 'Webhook not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

    return respond(request, { success: true, webhook: { id: webhook.id, name: webhook.name, url: webhook.url, status: webhook.status, events: webhook.events, lastSuccessAt: webhook.lastSuccessAt, lastFailureAt: webhook.lastFailureAt, failureCount: webhook.failureCount, createdAt: webhook.createdAt } }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const existing = await prisma.businessWebhookEndpoint.findFirst({ where: { id: params.id, businessId } })
    if (!existing) return respond(request, makeError('NOT_FOUND', 'Webhook not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

    let body: any
    try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }

    const update: any = {}
    if (body.name) update.name = body.name
    if (body.url) { if (!body.url.startsWith('https://')) return respond(request, makeError('INVALID_URL', 'URL must use https'), 400, startTime, businessId, { errorMessage: 'Invalid URL', rateLimit }); update.url = body.url }
    if (body.status) update.status = body.status
    if (body.events) update.events = body.events

    const updated = await prisma.businessWebhookEndpoint.update({ where: { id: params.id }, data: update })
    return respond(request, { success: true, webhook: { id: updated.id, name: updated.name, url: updated.url, status: updated.status, events: updated.events, createdAt: updated.createdAt } }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const existing = await prisma.businessWebhookEndpoint.findFirst({ where: { id: params.id, businessId } })
    if (!existing) return respond(request, makeError('NOT_FOUND', 'Webhook not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

    const deliveryCount = await prisma.webhookDelivery.count({ where: { endpointId: params.id } })
    if (deliveryCount > 0) {
      await prisma.businessWebhookEndpoint.update({ where: { id: params.id }, data: { status: 'INACTIVE' } })
      return respond(request, { success: true, disabled: true, message: 'Webhook has deliveries, disabled instead of deleted.' }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
    }

    await prisma.businessWebhookEndpoint.delete({ where: { id: params.id } })
    return respond(request, { success: true, deleted: true }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}