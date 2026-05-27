import { NextRequest, NextResponse } from 'next/server'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from './logging'
import { authenticateApiKey } from './auth'

export interface RespondOptions {
  apiKeyId?: string
  idempotencyKey?: string
  errorMessage?: string
  rateLimit?: { limit: number; remaining: number }
}

export async function respond(
  request: NextRequest,
  body: any,
  status: number,
  startTime: number,
  businessId: string,
  options?: RespondOptions,
): Promise<NextResponse> {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) {
    response = addRateLimitHeaders(response, options.rateLimit)
  }
  await logApiRequest(request, response, startTime, businessId, options)
  return response
}

export interface AuthBusinessResult {
  authError?: NextResponse
  businessId: string
  apiKeyId?: string
  rateLimit?: { limit: number; remaining: number }
}

export async function authenticateAndCheck(
  request: NextRequest,
  startTime: number,
): Promise<AuthBusinessResult> {
  const auth = await authenticateApiKey(request)

  if (!auth.authenticated) {
    const errorResponse = NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status || 401 },
    )
    return { authError: errorResponse, businessId: 'unknown' }
  }

  const businessId = auth.businessId!
  const apiKeyId = auth.apiKeyId

  const rateCheck = await checkRateLimit(businessId)
  const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }

  if (!rateCheck.allowed) {
    return { authError: addRateLimitHeaders(createRateLimitResponse(), rateCheck), businessId, apiKeyId, rateLimit }
  }

  return { businessId, apiKeyId, rateLimit }
}

export function addRateLimit(
  response: NextResponse,
  rateLimit?: { limit: number; remaining: number },
): NextResponse {
  if (rateLimit) {
    return addRateLimitHeaders(response, rateLimit)
  }
  return response
}
