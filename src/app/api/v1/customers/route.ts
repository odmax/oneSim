export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { serializePublicCustomer } from '@/lib/api/public-dto'

function makeError(c: string, m: string) { return { success: false, error: { code: c, message: m } } }

async function respond(req: NextRequest, body: any, status: number, startTime: number, businessId: string, opts?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let r = NextResponse.json(body, { status })
  if (opts?.rateLimit) r = addRateLimitHeaders(r, opts.rateLimit)
  await logApiRequest(req, r, startTime, businessId, { ...opts, errorMessage: opts?.errorMessage || (body?.error?.message || undefined) })
  return r
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

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')))
    const search = searchParams.get('search')

    const where: any = { businessId }
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }]

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.customer.count({ where }),
    ])

    return respond(request, {
      success: true,
      customers: customers.map(serializePublicCustomer),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
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

    let body: any; try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }
    if (!body.name || !body.email) return respond(request, makeError('MISSING_FIELDS', 'name and email are required'), 400, startTime, businessId, { errorMessage: 'Missing fields', rateLimit })

    const existing = await prisma.customer.findFirst({ where: { businessId, email: body.email } })
    if (existing) return respond(request, makeError('DUPLICATE', 'A customer with this email already exists'), 409, startTime, businessId, { errorMessage: 'Duplicate customer', rateLimit })

    const customer = await prisma.customer.create({
      data: { businessId, name: body.name, email: body.email, phone: body.phone || null, country: body.country || 'Unknown', status: 'ACTIVE' },
    })

    return respond(request, { success: true, customer: serializePublicCustomer(customer) }, 200, startTime, businessId, { apiKeyId: auth.apiKeyId, rateLimit })
  } catch (e: any) { console.error(e); return NextResponse.json(makeError('INTERNAL_ERROR', ''), { status: 500 }) }
}