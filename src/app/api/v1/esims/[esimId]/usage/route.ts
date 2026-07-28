export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { stripEsimProviderFields } from '@/lib/analytics/safe-fields'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function GET(request: NextRequest, { params }: { params: { esimId: string } }) {
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

    const esim = await prisma.eSIM.findUnique({
      where: { id: params.esimId },
      include: {
        purchase: { select: { businessId: true } },
        usageRecords: { orderBy: { timestamp: 'desc' }, take: 100 },
      },
    })

    if (!esim) return respond(request, makeError('ESIM_NOT_FOUND', 'eSIM not found'), 404, startTime, businessId, { errorMessage: 'eSIM not found', rateLimit })
    if (esim.purchase.businessId !== businessId) return respond(request, makeError('FORBIDDEN', 'eSIM does not belong to this business'), 403, startTime, businessId, { errorMessage: 'Forbidden', rateLimit })

    const safe = stripEsimProviderFields(esim)

    const responseBody = {
      success: true,
      esim: {
        id: safe.id,
        iccid: safe.iccid,
        imsi: safe.imsi,
        status: safe.status,
        expiresAt: safe.expiresAt?.toISOString() || null,
        dataUsedMB: safe.dataUsedMB,
        dataRemainingMB: safe.dataRemainingMB,
        dataTotalMB: safe.dataTotalMB,
        lastUsageSyncAt: safe.lastUsageSyncAt?.toISOString() || null,
      },
      usageRecords: esim.usageRecords.map((r) => ({
        dataUsedMB: r.dataUsedMB,
        dataTotalMB: r.dataTotalMB,
        dataRemainingMB: r.dataRemainingMB,
        timestamp: r.timestamp.toISOString(),
      })),
    }

    return respond(request, responseBody, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error) {
    console.error('API usage error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}