export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
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

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, status: true, walletBalance: true },
    })
    if (!business) return respond(request, makeError('BUSINESS_NOT_FOUND', 'Business not found'), 404, startTime, businessId, { errorMessage: 'Business not found', rateLimit })
    if (business.status === 'SUSPENDED') return respond(request, makeError('BUSINESS_SUSPENDED', 'Business account is suspended'), 403, startTime, businessId, { errorMessage: 'Business suspended', rateLimit })

    const [totalUsed, pendingCount, lastCredit, recentTx] = await Promise.all([
      prisma.walletTransaction.aggregate({
        where: { businessId, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      prisma.walletTopUpRequest.count({
        where: { businessId, status: 'PENDING' },
      }),
      prisma.walletTransaction.findFirst({
        where: { businessId, type: 'TOPUP' },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.walletTransaction.findFirst({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const balance = parseFloat(business.walletBalance.toString())
    const used = totalUsed._sum.amount ? Math.abs(parseFloat(totalUsed._sum.amount.toString())) : 0

    return respond(request, {
      success: true,
      wallet: {
        balance,
        currency: 'USD',
        totalUsed: used,
        pendingCreditRequests: pendingCount,
        lastCredit: lastCredit ? {
          id: lastCredit.id,
          amount: parseFloat(lastCredit.amount.toString()),
          description: lastCredit.description || null,
          createdAt: lastCredit.createdAt.toISOString(),
        } : null,
        lastTransaction: recentTx ? {
          id: recentTx.id,
          type: recentTx.type,
          amount: parseFloat(recentTx.amount.toString()),
          description: recentTx.description || null,
          createdAt: recentTx.createdAt.toISOString(),
        } : null,
      },
    }, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error: any) {
    console.error('API wallet error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}