export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { syncESIMStatus } from '@/lib/services/esims/sync-esim-status'
import { isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { requireRouteScopes } from '@/lib/api/v1-response'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

const UNAVAILABLE = makeError('capability_not_available', 'This operation is not available.')

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
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

    const esim = await prisma.eSIM.findUnique({
      where: { id: params.esimId },
      include: { purchase: { select: { businessId: true, package: { select: { providerId: true } } } } },
    })
    if (!esim) return respond(request, makeError('ESIM_NOT_FOUND', 'eSIM not found'), 404, startTime, businessId, { errorMessage: 'eSIM not found', rateLimit })
    if (esim.purchase.businessId !== businessId) return respond(request, makeError('FORBIDDEN', 'eSIM does not belong to this business'), 403, startTime, businessId, { errorMessage: 'Forbidden', rateLimit })

    if (!await isCapabilityExposedToApi(esim.purchase.package.providerId || '', 'STATUS' as any)) {
      return respond(request, UNAVAILABLE, 403, startTime, businessId, { errorMessage: 'capability_not_available', rateLimit })
    }

    const result = await syncESIMStatus(params.esimId)
    if (!result.success) return respond(request, makeError('SYNC_FAILED', result.error || 'Status sync failed'), 500, startTime, businessId, { errorMessage: result.error, rateLimit })

    return respond(request, { success: true, statusChanged: result.statusChanged, newStatus: result.newStatus, activated: result.activated }, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error: any) {
    console.error('API refresh-status error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}