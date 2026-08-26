export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { serializePublicCustomerDetail, serializePublicCustomer } from '@/lib/api/public-dto'

function makeError(c: string, m: string) { return { success: false, error: { code: c, message: m } } }

async function respond(req: NextRequest, body: any, status: number, startTime: number, businessId: string, opts?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let r = NextResponse.json(body, { status })
  if (opts?.rateLimit) r = addRateLimitHeaders(r, opts.rateLimit)
  await logApiRequest(req, r, startTime, businessId, { ...opts, errorMessage: opts?.errorMessage || (body?.error?.message || undefined) })
  return r
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

    const customer = await prisma.customer.findFirst({ where: { id: params.id, businessId }, include: { _count: { select: { esims: true, esimTopUps: true } } } })
    if (!customer) return respond(request, makeError('NOT_FOUND', 'Customer not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

    return respond(request, {
      success: true,
      customer: serializePublicCustomerDetail(customer),
    }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
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

    const existing = await prisma.customer.findFirst({ where: { id: params.id, businessId } })
    if (!existing) return respond(request, makeError('NOT_FOUND', 'Customer not found'), 404, startTime, businessId, { errorMessage: 'Not found', rateLimit })

    let body: any; try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }

    const update: any = {}
    if (body.name) update.name = body.name
    if (body.email) update.email = body.email
    if (body.phone !== undefined) update.phone = body.phone
    if (body.country) update.country = body.country
    if (body.status) update.status = body.status

    const customer = await prisma.customer.update({ where: { id: params.id, businessId }, data: update })
    return respond(request, { success: true, customer: serializePublicCustomer(customer) }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}