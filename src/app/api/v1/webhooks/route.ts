import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import crypto from 'crypto'

const EVENT_TYPES = ['order.completed', 'order.failed', 'esim.provisioned', 'esim.activated', 'esim.expired', 'esim.suspended', 'usage.updated', 'topup.completed', 'topup.failed', 'wallet.low_balance']

function makeError(code: string, message: string) { return { success: false, error: { code, message } } }

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const endpoints = await prisma.businessWebhookEndpoint.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    })

    return respond(request, { success: true, webhooks: endpoints.map(e => ({ id: e.id, name: e.name, url: e.url, status: e.status, events: e.events, lastSuccessAt: e.lastSuccessAt, lastFailureAt: e.lastFailureAt, failureCount: e.failureCount, createdAt: e.createdAt })) }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    let body: any
    try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }

    if (!body.name || !body.url) return respond(request, makeError('MISSING_FIELDS', 'name and url are required'), 400, startTime, businessId, { errorMessage: 'Missing fields', rateLimit })
    if (!body.url.startsWith('https://')) return respond(request, makeError('INVALID_URL', 'URL must use https'), 400, startTime, businessId, { errorMessage: 'Invalid URL', rateLimit })

    const events = body.events || ['*']
    const invalid = events.filter((e: string) => e !== '*' && !EVENT_TYPES.includes(e))
    if (invalid.length > 0) return respond(request, makeError('INVALID_EVENTS', `Invalid event types: ${invalid.join(', ')}`), 400, startTime, businessId, { errorMessage: 'Invalid events', rateLimit })

    const secret = crypto.randomBytes(24).toString('hex')
    const endpoint = await prisma.businessWebhookEndpoint.create({
      data: { businessId, name: body.name, url: body.url, secret, events, status: 'ACTIVE' },
    })

    return respond(request, { success: true, webhook: { id: endpoint.id, name: endpoint.name, url: endpoint.url, secret: endpoint.secret, events: endpoint.events, status: endpoint.status, createdAt: endpoint.createdAt } }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}