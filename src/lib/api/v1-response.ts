import { NextRequest, NextResponse } from 'next/server'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from './logging'
import { authenticateApiKey } from './auth'
import { apiError, generateRequestId, type ApiErrorCode } from './error-contract'

export interface RespondOptions {
  apiKeyId?: string
  idempotencyKey?: string
  errorCode?: ApiErrorCode
  errorMessage?: string
  rateLimit?: { limit: number; remaining: number }
  requestId?: string
  details?: any
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
  requestId: string
}

export async function authenticateAndCheck(
  request: NextRequest,
  startTime: number,
): Promise<AuthBusinessResult> {
  const requestId = generateRequestId()
  const auth = await authenticateApiKey(request)

  if (!auth.authenticated) {
    const errorResponse = apiError(
      auth.status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED',
      auth.error || 'Invalid or revoked API key',
      auth.status || 401,
      undefined,
      requestId,
    )
    return { authError: errorResponse, businessId: 'unknown', requestId }
  }

  const businessId = auth.businessId!
  const apiKeyId = auth.apiKeyId

  const rateCheck = await checkRateLimit(businessId)
  const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }

  if (!rateCheck.allowed) {
    const errorResponse = apiError('RATE_LIMITED', 'API rate limit exceeded', 429, undefined, requestId)
    return { authError: addRateLimitHeaders(errorResponse, rateCheck), businessId, apiKeyId, rateLimit, requestId }
  }

  return { businessId, apiKeyId, rateLimit, requestId }
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
