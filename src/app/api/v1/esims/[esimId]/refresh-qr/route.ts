export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { refreshEsimQrCode } from '@/lib/services/esims/refresh-qr'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

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

    const result = await refreshEsimQrCode({
      esimId: params.esimId,
      businessId,
      requestedBy: auth.apiKeyId,
    })

    if (!result.success) {
      switch (result.outcome) {
        case 'NOT_FOUND':
          return respond(request, makeError('NOT_FOUND', result.error || 'eSIM not found'), 404, startTime, businessId, { rateLimit })
        case 'FORBIDDEN':
          return respond(request, makeError('FORBIDDEN', result.error || 'Access denied'), 403, startTime, businessId, { rateLimit })
        case 'PROVIDER_UNAVAILABLE':
          return respond(request, makeError('QR_PROVIDER_UNRESOLVED', result.error || 'Provider could not be resolved'), 422, startTime, businessId, { rateLimit })
        case 'NOT_SUPPORTED':
          return respond(request, makeError('QR_REFRESH_NOT_SUPPORTED', result.error || 'QR refresh is not supported for this provider'), 422, startTime, businessId, { rateLimit })
        case 'NO_DATA':
          return respond(request, makeError('QR_NOT_AVAILABLE', result.error || 'QR code is not available yet'), 404, startTime, businessId, { rateLimit })
        case 'PROVIDER_FAILED':
          return respond(request, makeError('PROVIDER_REQUEST_FAILED', result.error || 'Provider request failed'), 502, startTime, businessId, { rateLimit })
        default:
          return respond(request, makeError('INTERNAL_ERROR', result.error || 'Internal server error'), 500, startTime, businessId, { rateLimit })
      }
    }

    return respond(request, { success: true, esim: result.esim }, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error: any) {
    console.error('API refresh-qr error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}
