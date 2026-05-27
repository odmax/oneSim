import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { createOrder } from '@/lib/services/orders/create-order'

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; idempotencyKey?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) {
    response = addRateLimitHeaders(response, options.rateLimit)
  }
  await logApiRequest(request, response, startTime, businessId, options)
  return response
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)

    if (!auth.authenticated) {
      return respond(request, { success: false, error: auth.error }, auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    }

    const businessId = auth.businessId!
    const apiKeyId = auth.apiKeyId

    // Rate limit check
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) {
      return addRateLimitHeaders(createRateLimitResponse(), rateCheck)
    }

    // Check business status
    const business = await prisma.business.findUnique({
      where: { id: businessId },
    })

    if (!business) {
      return respond(request, { success: false, error: 'Business not found' }, 404, startTime, businessId, { errorMessage: 'Business not found', rateLimit })
    }

    if (business.status === 'SUSPENDED') {
      return respond(request, { success: false, error: 'Business account is suspended' }, 403, startTime, businessId, { errorMessage: 'Business suspended', rateLimit })
    }

    // Idempotency check
    const idempotencyKey = request.headers.get('Idempotency-Key')
    if (idempotencyKey) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: { key: `${businessId}:${idempotencyKey}` },
      })

      if (existing) {
        return respond(request, existing.response as any, 200, startTime, businessId, { idempotencyKey, rateLimit })
      }
    }

    // Parse body
    let body: any
    try {
      body = await request.json()
    } catch {
      return respond(request, { success: false, error: 'Invalid JSON body' }, 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit })
    }

    const {
      externalCustomerId,
      customerName,
      customerEmail,
      customerPhone,
      country,
      packageId,
      sku,
      packageCode,
      quantity = 1,
      callbackUrl,
    } = body

    // Validate required fields
    if (!customerName || !customerEmail) {
      return respond(request, { success: false, error: 'customerName and customerEmail are required' }, 400, startTime, businessId, { errorMessage: 'Missing fields', rateLimit })
    }

    if (!packageId && !sku && !packageCode) {
      return respond(request, { success: false, error: 'One of packageId, sku, or packageCode is required' }, 400, startTime, businessId, { errorMessage: 'Missing package identifier', rateLimit })
    }

    // Find business user for purchase ownership
    const businessUser = await prisma.businessUser.findFirst({
      where: { businessId, role: 'ADMIN' },
      include: { user: true },
    })

    if (!businessUser) {
      return respond(request, { success: false, error: 'No business admin found for this account' }, 500, startTime, businessId, { errorMessage: 'No admin user', rateLimit })
    }

    const result = await createOrder({
      businessId,
      userId: businessUser.user.id,
      packageId,
      sku,
      packageCode,
      quantity,
      callbackUrl,
      customer: {
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
        country,
        externalId: externalCustomerId,
      },
    })

    if (!result.success) {
      return respond(request, { success: false, error: result.error }, result.errorStatus || 500, startTime, businessId, { errorMessage: result.error, rateLimit })
    }

    const responseBody = {
      success: true,
      orderId: result.orderId,
      customerId: result.customerId,
      status: result.status,
      unitCost: result.unitCost,
      totalCost: result.totalCost,
      quantity: result.quantity,
      currency: result.currency || 'USD',
      esims: result.esims?.map((e) => ({
        id: e.id,
        iccid: e.iccid,
        status: e.status,
        qrCodeUrl: e.qrCodeUrl,
      })),
    }

    // Store idempotency record
    if (idempotencyKey) {
      await prisma.idempotencyRecord.create({
        data: {
          key: `${businessId}:${idempotencyKey}`,
          businessId,
          response: responseBody as any,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }).catch(() => {})
    }

    return respond(request, responseBody, 200, startTime, businessId, { idempotencyKey: idempotencyKey || undefined, apiKeyId, rateLimit })

  } catch (error) {
    console.error('API order error:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({
    service: 'OneSim External API',
    version: 'v1',
    endpoints: {
      order: 'POST /api/v1/esims/order',
    },
  })
}
