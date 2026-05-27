import { prisma } from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function logApiRequest(
  request: NextRequest,
  response: NextResponse,
  startTime: number,
  businessId: string,
  options?: {
    apiKeyId?: string
    idempotencyKey?: string
    errorMessage?: string
  },
) {
  const durationMs = Date.now() - startTime

  try {
    await prisma.apiRequestLog.create({
      data: {
        businessId,
        apiKeyId: options?.apiKeyId || null,
        method: request.method,
        path: request.nextUrl.pathname,
        statusCode: response.status,
        durationMs,
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
        userAgent: request.headers.get('user-agent') || null,
        idempotencyKey: options?.idempotencyKey || null,
        errorMessage: options?.errorMessage || null,
      },
    })
  } catch {
    // Logging is best-effort
  }
}

export async function checkRateLimit(businessId: string): Promise<{ allowed: boolean; limit: number; remaining: number }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { rateLimitPerMinute: true },
  })

  const defaultLimit = 60
  const limit = business?.rateLimitPerMinute || defaultLimit

  const oneMinuteAgo = new Date(Date.now() - 60 * 1000)

  const count = await prisma.apiRequestLog.count({
    where: {
      businessId,
      createdAt: { gte: oneMinuteAgo },
    },
  })

  const remaining = Math.max(0, limit - count)
  return { allowed: count < limit, limit, remaining }
}

export function addRateLimitHeaders(
  response: NextResponse,
  { limit, remaining }: { limit: number; remaining: number },
): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(limit))
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  return response
}

export function createRateLimitResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: 'Rate limit exceeded. Please reduce request volume and retry after 60 seconds.',
    },
    {
      status: 429,
      headers: {
        'Retry-After': '60',
      },
    },
  )
}
