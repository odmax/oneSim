export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { apiError, generateRequestId } from '@/lib/api/error-contract'
import { requireRouteScopes } from '@/lib/api/v1-response'
import crypto from 'crypto'

function makeError(c: string, m: string) { return { success: false, error: { code: c, message: m } } }

async function respond(req: NextRequest, body: any, status: number, st: number, biz: string, opts?: any) {
  let r = NextResponse.json(body, { status })
  if (opts?.rateLimit) r = addRateLimitHeaders(r, opts.rateLimit)
  await logApiRequest(req, r, st, biz, opts)
  return r
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const startTime = Date.now()
  const requestId = generateRequestId()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return apiError('UNAUTHORIZED', auth.error || 'Invalid API key', auth.status || 401, undefined, requestId)
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const scopeError = requireRouteScopes(request, auth)
    if (scopeError) return scopeError

    const endpoint = await prisma.businessWebhookEndpoint.findFirst({ where: { id: params.id, businessId } })
    if (!endpoint) return apiError('NOT_FOUND', 'Webhook endpoint not found', 404, undefined, requestId)

    const eventId = `evt_test_${crypto.randomBytes(8).toString('hex')}`
    const payload = { id: eventId, type: 'webhook.test', createdAt: new Date().toISOString(), data: { message: 'This is a test webhook from OneSIM' } }
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = crypto.createHmac('sha256', endpoint.secret).update(`${timestamp}.${body}`).digest('hex')

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)
      const response = await fetch(endpoint.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OneSim-Event': 'webhook.test', 'X-OneSim-Event-Id': eventId, 'X-OneSim-Timestamp': String(timestamp), 'X-OneSim-Signature': signature, 'User-Agent': 'OneSim-Webhook/1.0' },
        body, signal: controller.signal,
      })
      clearTimeout(timeoutId)
      const respBody = await response.text()

      await prisma.webhookDelivery.create({
        data: { businessId, endpointId: endpoint.id, eventType: 'webhook.test', eventId, payload, status: response.ok ? 'SENT' : 'FAILED', responseCode: response.status, responseBody: respBody.substring(0, 2000), attempts: 1, sentAt: response.ok ? new Date() : undefined, errorMessage: response.ok ? null : `HTTP ${response.status}` },
      })

      if (response.ok) {
        await prisma.businessWebhookEndpoint.update({ where: { id: endpoint.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } })
        return NextResponse.json({ success: true, message: 'Test webhook sent successfully', statusCode: response.status, requestId }, { status: 200, headers: { 'X-Request-Id': requestId } })
      } else {
        await prisma.businessWebhookEndpoint.update({ where: { id: endpoint.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } })
        return apiError('SERVICE_UNAVAILABLE', `Endpoint returned HTTP ${response.status}`, 200, undefined, requestId)
      }
    } catch (e: any) {
      await prisma.webhookDelivery.create({
        data: { businessId, endpointId: endpoint.id, eventType: 'webhook.test', eventId, payload, status: 'FAILED', errorMessage: e.message?.substring(0, 500) || 'Connection failed', attempts: 1 },
      })
      await prisma.businessWebhookEndpoint.update({ where: { id: endpoint.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } }).catch(() => {})
      return apiError('SERVICE_UNAVAILABLE', 'Connection to webhook endpoint failed', 200, undefined, requestId)
    }
  } catch (e: any) {
    console.error(e)
    return apiError('INTERNAL_ERROR', 'An internal error occurred', 500, undefined, requestId)
  }
}