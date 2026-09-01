export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { createOrder } from '@/lib/services/orders/create-order'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { getActivationInstructions } from '@/lib/esim/activation-instructions'
import { isValidTravelDate } from '@/lib/providers/travel-date-utils'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import { requireRouteScopes } from '@/lib/api/v1-response'
import { canonicalPurchaseIdentity, stripIdempotencyIdentity, hasIdempotencyIdentity } from '@/lib/api/idempotency-identity'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; idempotencyKey?: string; errorMessage?: string; rateLimit?: { limit: number | null; remaining: number | null } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) {
      return respond(request, makeError('AUTH_FAILED', auth.error || 'Authentication failed'), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    }

    const businessId = auth.businessId!
    const apiKeyId = auth.apiKeyId

    // Rate limit
    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const scopeError = requireRouteScopes(request, auth)
    if (scopeError) {
      await logApiRequest(request, scopeError, startTime, businessId, { apiKeyId, errorMessage: 'insufficient_scopes' })
      return scopeError
    }

    // Business check
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, status: true, walletBalance: true } })
    if (!business) return respond(request, makeError('BUSINESS_NOT_FOUND', 'Business not found'), 404, startTime, businessId, { errorMessage: 'Business not found', rateLimit })
    if (business.status === 'SUSPENDED') return respond(request, makeError('BUSINESS_SUSPENDED', 'Business account is suspended'), 403, startTime, businessId, { errorMessage: 'Business suspended', rateLimit })

    // Parse body
    let body: any
    try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON body'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }

    const { externalCustomerId, customerName, customerEmail, customerPhone, country, packageId, sku, packageCode, quantity = 1, callbackUrl, travelDate } = body

    if (!customerName || !customerEmail) return respond(request, makeError('MISSING_FIELDS', 'customerName and customerEmail are required'), 400, startTime, businessId, { errorMessage: 'Missing fields', rateLimit })
    if (!packageId && !sku && !packageCode) return respond(request, makeError('MISSING_PACKAGE_ID', 'One of packageId, sku, or packageCode is required'), 400, startTime, businessId, { errorMessage: 'Missing package identifier', rateLimit })
    if (quantity < 1 || quantity > 100) return respond(request, makeError('INVALID_QUANTITY', 'quantity must be between 1 and 100'), 400, startTime, businessId, { errorMessage: 'Invalid quantity', rateLimit })
    if (travelDate !== undefined && travelDate !== null && travelDate !== '' && !isValidTravelDate(travelDate)) {
      return respond(request, makeError('INVALID_TRAVEL_DATE', 'travelDate must be a valid date in YYYY-MM-DD format'), 400, startTime, businessId, { errorMessage: 'Invalid travelDate', rateLimit })
    }

    // Resolve package for preview
    const { resolvePackageIdentifier } = await import('@/lib/packages/resolve-package')
    const resolution = await resolvePackageIdentifier({ packageId, sku, packageCode })
    if (!resolution || resolution.package.source === 'PROVIDER_PLAN') {
      return respond(request, makeError('PACKAGE_UNAVAILABLE', 'This package is no longer available.'), 404, startTime, businessId, { errorMessage: 'Package unavailable', rateLimit })
    }
    const pkg = resolution.package

    // Idempotency â€” payload-bound replay (Phase 6.1). Same business + key +
    // canonical purchase identity (resolved package, quantity, travelDate-as-
    // provided) â‡’ deterministic replay of the original response. A materially
    // different request under the same key is REJECTED with HTTP 409 (no second
    // order, no second reserve, no second dispatch). Records without a stored
    // identity (legacy/no-key-identity) fall back to replay â€” never a second order.
    const idempotencyKey = request.headers.get('Idempotency-Key')
    let incomingIdentity: string | null = null
    if (idempotencyKey) {
      incomingIdentity = canonicalPurchaseIdentity({ resolvedPackageId: pkg.id, quantity, travelDate })
      const existing = await prisma.idempotencyRecord.findUnique({ where: { key: `${businessId}:${idempotencyKey}` } })
      if (existing) {
        if (hasIdempotencyIdentity(existing.response)) {
          const stored = (existing.response as any)?.__requestIdentity
          if (incomingIdentity !== stored) {
            return respond(request, makeError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request.'), 409, startTime, businessId, { idempotencyKey, rateLimit })
          }
        }
        return respond(request, stripIdempotencyIdentity(existing.response) as any, 200, startTime, businessId, { idempotencyKey, rateLimit })
      }
    }

    // Phase 5C â€” purchasability check using centralized readiness
    if (pkg.providerPackageId) {
      const pp = await prisma.providerPackage.findUnique({
        where: { id: pkg.providerPackageId },
        select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true, provider: { select: { status: true, enabledCapabilities: true, code: true } } },
      })
      if (!pp) {
        return respond(request, makeError('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.'), 400, startTime, businessId, { errorMessage: 'Provider package not found', rateLimit })
      }
      const readiness = getPackagePurchaseReadiness({
        providerPkg: { costStatus: pp.costStatus, pricingStatus: pp.pricingStatus, publishStatus: pp.publishStatus, configurationStatus: pp.configurationStatus, activePriceSnapshotId: pp.activePriceSnapshotId, sellingPrice: pp.sellingPrice, costPrice: pp.costPrice },
        provider: { status: pp.provider.status, enabledCapabilities: pp.provider.enabledCapabilities, code: pp.provider.code },
      })
      if (!readiness.ready) {
        return respond(request, makeError('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.'), 400, startTime, businessId, { errorMessage: readiness.reasons.join('; '), rateLimit })
      }
    }

    // Wallet check
    const totalAmount = parseFloat(pkg.priceUSD.toString()) * quantity
    if (parseFloat(business.walletBalance.toString()) < totalAmount) {
      return respond(request, makeError('INSUFFICIENT_WALLET_BALANCE', 'Insufficient wallet balance. Please request credit before ordering.'), 402, startTime, businessId, { errorMessage: 'Insufficient balance', rateLimit })
    }

    // Find business user
    const businessUser = await prisma.businessUser.findFirst({
      where: { businessId, role: 'ADMIN' },
      include: { user: true },
    })
    if (!businessUser) return respond(request, makeError('NO_ADMIN_USER', 'No business admin found for this account'), 500, startTime, businessId, { errorMessage: 'No admin user', rateLimit })

    const result = await createOrder({
      businessId,
      userId: businessUser.user.id,
      packageId,
      sku,
      packageCode,
      quantity,
      callbackUrl,
      idempotencyKey: idempotencyKey || undefined,
      customer: { name: customerName, email: customerEmail, phone: customerPhone, country, externalId: externalCustomerId },
      travelDate: travelDate || undefined,
      // TRUSTED REQUEST CONTEXT: reuse the package the route already resolved and
      // validated (tenant-pinned to the authenticated business). The orchestrator
      // still runs backing/readiness/price-guard/travel/wallet checks unchanged.
      resolvedPackage: resolution.package,
      // Identity-only pin: the authenticated business id (never from the body).
      // No status/wallet state is passed; the orchestrator re-reads those fresh.
      authenticatedBusinessId: businessId,
      async: true,
    })

    if (!result.success) {
      const errMsg = result.error || ''
      let code = 'PURCHASE_FAILED'
      if (errMsg.includes('wallet') || errMsg.includes('Insufficient')) code = 'INSUFFICIENT_WALLET_BALANCE'
      else if (errMsg.includes('Provider') || errMsg.includes('provider') || errMsg.includes('ICCID')) code = 'PROVIDER_PROVISIONING_FAILED'
      else if (errMsg.includes('Package') || errMsg.includes('package') || errMsg.includes('available')) code = 'PACKAGE_UNAVAILABLE'
      return respond(request, makeError(code, errMsg), result.errorStatus || 500, startTime, businessId, { errorMessage: errMsg, rateLimit })
    }

    const safePkg = stripPackageProviderFields(pkg) as any
    const walletDeducted = parseFloat(pkg.priceUSD.toString()) * quantity
    const firstEsim = result.esims?.[0]

    const responseBody = {
      success: true,
      order: {
        id: result.orderId,
        status: result.status,
        quantity: result.quantity,
        unitCost: result.unitCost,
        totalCost: result.totalCost,
        currency: result.currency || 'USD',
        createdAt: new Date().toISOString(),
      },
      package: {
        id: pkg.id,
        displayName: safePkg.displayName || safePkg.name,
        customerDescription: safePkg.customerDescription || safePkg.description || null,
        dataGB: pkg.dataGB,
        validityDays: pkg.validityDays,
        unitCost: result.unitCost,
        currency: result.currency || 'USD',
      },
      esims: (result.esims || []).map((e) => ({
        id: e.id,
        iccid: e.iccid,
        imsi: e.imsi || null,
        activationCode: e.activationCode || null,
        qrCodeUrl: e.qrCodeUrl || null,
        status: e.status,
        expiresAt: new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000).toISOString(),
        activationInstructions: getActivationInstructions(!!e.qrCodeUrl),
      })),
      wallet: {
        deducted: walletDeducted,
        currency: result.currency || 'USD',
      },
    }

    // Store idempotency record â€” carries the canonical request identity (private
    // `__requestIdentity`, stripped from every client-facing replay).
    if (idempotencyKey) {
      await prisma.idempotencyRecord.create({
        data: { key: `${businessId}:${idempotencyKey}`, businessId, response: { ...(responseBody as any), __requestIdentity: incomingIdentity } as any, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      }).catch(() => {})
    }

    return respond(request, responseBody, 200, startTime, businessId, { idempotencyKey: idempotencyKey || undefined, apiKeyId, rateLimit })

  } catch (error) {
    console.error('API order error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    service: 'OneSIM External API',
    version: 'v1',
    endpoints: { order: 'POST /api/v1/esims/order' },
  })
}
