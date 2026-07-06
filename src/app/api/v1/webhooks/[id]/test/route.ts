import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
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
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) return respond(request, makeError('AUTH_FAILED', auth.error || ''), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    const businessId = auth.businessId!
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const endpoint = await prisma.businessWebhookEndpoint.findFirst({ where: { id: params.id, businessId } })
    if (!endpoint) return respond(request, makeError('NOT_FOUND', 'Webhook endpoint not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

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
      } else {
        await prisma.businessWebhookEndpoint.update({ where: { id: endpoint.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } })
      }

      return respond(request, { success: response.ok, message: response.ok ? 'Test webhook sent successfully' : `Endpoint returned ${response.status}`, statusCode: response.status }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
    } catch (e: any) {
      await prisma.webhookDelivery.create({
        data: { businessId, endpointId: endpoint.id, eventType: 'webhook.test', eventId, payload, status: 'FAILED', errorMessage: e.message?.substring(0, 500) || 'Connection failed', attempts: 1 },
      })
      await prisma.businessWebhookEndpoint.update({ where: { id: endpoint.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } }).catch(() => {})
      return respond(request, { success: false, message: `Connection failed: ${e.message}` }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
    }
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}