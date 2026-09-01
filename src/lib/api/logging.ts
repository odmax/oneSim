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

export async function checkRateLimit(businessId: string): Promise<{ allowed: boolean; limit: number | null; remaining: number | null; resetAt: Date }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { rateLimitPerMinute: true },
  })

// NO business-level hard ceiling when the business has no explicit positive
  // rateLimitPerMinute. The old accidental 60-per-minute default is removed —
  // high-volume clients are not rejected by a fabricated default; provider
  // safety is enforced by provider execution lanes + the durable queue, not by
  // a client request ceiling.
  const limit = business?.rateLimitPerMinute
  const now = Date.now()
  const oneMinuteAgo = new Date(now - 60 * 1000)
  const resetAt = new Date(now + 60 * 1000)
  resetAt.setSeconds(0, 0)

  if (!limit || limit <= 0) {
    return { allowed: true, limit: null, remaining: null, resetAt }
  }

  const count = await prisma.apiRequestLog.count({
    where: {
      businessId,
      createdAt: { gte: oneMinuteAgo },
    },
  })

  const remaining = Math.max(0, limit - count)
  return { allowed: count < limit, limit, remaining, resetAt }
}

export function addRateLimitHeaders(
  response: NextResponse,
  { limit, remaining, resetAt }: { limit: number | null | undefined; remaining: number | null | undefined; resetAt?: Date },
): NextResponse {
  if (typeof limit === 'number' && Number.isFinite(limit)) response.headers.set('X-RateLimit-Limit', String(limit))
  if (typeof remaining === 'number' && Number.isFinite(remaining)) response.headers.set('X-RateLimit-Remaining', String(remaining))
  if (resetAt) response.headers.set('X-RateLimit-Reset', String(Math.floor(resetAt.getTime() / 1000)))
  return response
}

export function createRateLimitResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'API rate limit exceeded. Please reduce request volume and retry.',
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': '60',
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '0',
      },
    },
  )
}
