export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { createTopUpOrder } from '@/lib/services/orders/top-up-order'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import { isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { requireRouteScopes } from '@/lib/api/v1-response'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

const UNAVAILABLE = makeError('capability_not_available', 'This operation is not available.')

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number | null; remaining: number | null } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function POST(request: NextRequest, { params }: { params: { esimId: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) {
      return respond(request, makeError('AUTH_FAILED', auth.error || 'Authentication failed'), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    }

    const businessId = auth.businessId!
    const apiKeyId = auth.apiKeyId

const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const scopeError = requireRouteScopes(request, auth)
    if (scopeError) {
      await logApiRequest(request, scopeError, startTime, businessId, { apiKeyId, errorMessage: 'insufficient_scopes' })
      return scopeError
    }

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, status: true } })
    if (!business) return respond(request, makeError('BUSINESS_NOT_FOUND', 'Business not found'), 404, startTime, businessId, { errorMessage: 'Business not found', rateLimit })
    if (business.status === 'SUSPENDED') return respond(request, makeError('BUSINESS_SUSPENDED', 'Business account is suspended'), 403, startTime, businessId, { errorMessage: 'Business suspended', rateLimit })

    let body: any
    try { body = await request.json() } catch { return respond(request, makeError('INVALID_JSON', 'Invalid JSON body'), 400, startTime, businessId, { errorMessage: 'Invalid JSON', rateLimit }) }

    const { packageId, sku, packageCode, quantity = 1, idempotencyKey } = body

    if (!packageId && !sku && !packageCode) {
      return respond(request, makeError('MISSING_PACKAGE_ID', 'One of packageId, sku, or packageCode is required'), 400, startTime, businessId, { errorMessage: 'Missing package identifier', rateLimit })
    }

    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      return respond(request, makeError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be a string between 8 and 128 characters'), 400, startTime, businessId, { errorMessage: 'Invalid idempotencyKey', rateLimit })
    }

    const { resolvePackageIdentifier } = await import('@/lib/packages/resolve-package')
    const resolution = await resolvePackageIdentifier({ packageId, sku, packageCode })
    if (!resolution) {
      return respond(request, makeError('INVALID_TOPUP_PACKAGE', 'Top-up package not found'), 404, startTime, businessId, { errorMessage: 'Package not found', rateLimit })
    }

    // Phase 5C â€” purchasability check using centralized readiness
    if (resolution.package.providerPackageId) {
      const pp = await prisma.providerPackage.findUnique({
        where: { id: resolution.package.providerPackageId },
        select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true, providerId: true, provider: { select: { status: true, enabledCapabilities: true, code: true } } },
      })
      if (!pp) {
        return respond(request, makeError('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable.'), 400, startTime, businessId, { errorMessage: 'Provider package not found', rateLimit })
      }
      const readiness = getPackagePurchaseReadiness({
        providerPkg: { costStatus: pp.costStatus, pricingStatus: pp.pricingStatus, publishStatus: pp.publishStatus, configurationStatus: pp.configurationStatus, activePriceSnapshotId: pp.activePriceSnapshotId, sellingPrice: pp.sellingPrice, costPrice: pp.costPrice },
        provider: { status: pp.provider.status, enabledCapabilities: pp.provider.enabledCapabilities, code: pp.provider.code },
      })
      if (!readiness.ready) {
        return respond(request, makeError('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable.'), 400, startTime, businessId, { errorMessage: readiness.reasons.join('; '), rateLimit })
      }
      if (!await isCapabilityExposedToApi(pp.providerId, 'TOP_UP' as any)) {
        return respond(request, UNAVAILABLE, 403, startTime, businessId, { errorMessage: 'capability_not_available', rateLimit })
      }
    }

    // Find business user for audit
    const businessUser = await prisma.businessUser.findFirst({
      where: { businessId, role: 'ADMIN' },
      include: { user: true },
    })
    if (!businessUser) return respond(request, makeError('NO_ADMIN_USER', 'No business admin found'), 500, startTime, businessId, { errorMessage: 'No admin user', rateLimit })

    const result = await createTopUpOrder({
      businessId,
      userId: businessUser.user.id,
      esimId: params.esimId,
      topUpPackageId: resolution.package.id,
      quantity,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })

    if (!result.success) {
      let code = 'TOPUP_FAILED'
      if (result.error?.includes('wallet') || result.error?.includes('Insufficient')) code = 'INSUFFICIENT_WALLET_BALANCE'
      else if (result.error?.includes('top-up') || result.error?.includes('Top-up')) code = 'INVALID_TOPUP_PACKAGE'
      else if (result.error?.includes('Provider') || result.error?.includes('provider')) code = 'PROVIDER_TOPUP_FAILED'
      else if (result.error?.includes('not found')) code = 'ESIM_NOT_FOUND'
      else if (result.error?.includes('not available')) code = 'TOPUP_NOT_AVAILABLE'
      return respond(request, makeError(code, result.error!), result.errorStatus || 500, startTime, businessId, { errorMessage: result.error, rateLimit })
    }

    const updatedEsim = await prisma.eSIM.findUnique({
      where: { id: params.esimId },
      select: { id: true, iccid: true, imsi: true, status: true, expiresAt: true, dataUsedMB: true, dataRemainingMB: true },
    })

    const responseBody = {
      success: true,
      topUp: {
        id: result.topUpId,
        status: result.status || 'COMPLETED',
        amount: result.amount,
        currency: result.currency || 'USD',
        dataAddedMB: result.dataAddedMB,
        validityDaysAdded: result.validityDaysAdded,
      },
      esim: updatedEsim ? {
        id: updatedEsim.id,
        iccid: updatedEsim.iccid,
        imsi: updatedEsim.imsi,
        status: updatedEsim.status,
        expiresAt: updatedEsim.expiresAt?.toISOString(),
        dataUsedMB: updatedEsim.dataUsedMB,
        dataRemainingMB: updatedEsim.dataRemainingMB,
      } : null,
      wallet: {
        deducted: result.amount,
        currency: result.currency || 'USD',
      },
    }

    return respond(request, responseBody, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error) {
    console.error('API top-up error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}