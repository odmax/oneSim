export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { serializePublicUsageEsim } from '@/lib/api/public-dto'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number | null; remaining: number | null } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100)

    const esimWhere: any = {
      purchase: { businessId },
    }
    if (status) esimWhere.status = status
    if (search) {
      esimWhere.OR = [
        { iccid: { contains: search } },
        { imsi: { contains: search } },
      ]
    }

    const [esims, totalEsims] = await Promise.all([
      prisma.eSIM.findMany({
        where: esimWhere,
        include: {
          purchase: { include: { package: true } },
          usageRecords: { orderBy: { timestamp: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.eSIM.count({ where: esimWhere }),
    ])

    const esimList = esims.map(serializePublicUsageEsim)

    const totalDataUsed = esims.reduce((sum, e) => sum + (e.dataUsedMB || 0), 0)
    const activeCount = esims.filter((e) => e.status === 'ACTIVE').length

    const responseBody = {
      success: true,
      esims: esimList,
      summary: {
        totalEsims,
        activeCount,
        totalDataUsedMB: totalDataUsed,
      },
      page,
      limit,
    }

    return respond(request, responseBody, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error) {
    console.error('API usage list error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}