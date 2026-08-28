import { NextRequest, NextResponse } from 'next/server'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from './logging'
import { authenticateApiKey } from './auth'
import { apiError, generateRequestId, type ApiErrorCode } from './error-contract'
import { classifyV1Route, hasScope, type ApiScope } from './scopes'

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
  scopes?: ApiScope[]
  rateLimit?: { limit: number; remaining: number }
  requestId: string
}

/**
 * Enforce API-key scopes for a given HTTP method + route path.
 *
 * FAIL-CLOSED: a /api/v1 route with no registered scope policy (not in
 * ROUTE_SCOPE_MAP, not explicitly bootstrap-exempt) returns a 403 FORBIDDEN.
 * Bootstrap routes return null (their handlers do their own lighter checks).
 * Legacy keys with an empty scopes array get full access during migration.
 */
export function requireRouteScopes(
  req: NextRequest,
  auth: { scopes?: string[] },
  context: { method?: string } = {},
): NextResponse | null {
  const method = context.method || req.method || 'GET'
  const pathname = new URL(req.url).pathname
  const classified = classifyV1Route(method, pathname)

  if (classified.kind === 'BOOTSTRAP') {
    // SIGN_IN/publish routes are handled by their own handlers; no scope check.
    return null
  }

  if (classified.kind === 'UNREGISTERED') {
    // Fail closed: no implicit auth-only-allowed fallback for Business routes.
    return apiError('FORBIDDEN', 'This Business route has no registered API scope policy. Contact support.', 403, undefined, generateRequestId())
  }

  const required = classified.scopes
  if (!hasScope(auth.scopes as ApiScope[] | undefined, required)) {
    return apiError('FORBIDDEN', `Insufficient API key scopes. Required: ${required.join(', ')}`, 403, undefined, generateRequestId())
  }
  return null
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

  // Scope enforcement for routes that authenticate via this shared helper.
  const scopeError = requireRouteScopes(request, auth)
  if (scopeError) {
    return { authError: scopeError, businessId, apiKeyId, rateLimit, requestId }
  }

  return { businessId, apiKeyId, scopes: auth.scopes as ApiScope[], rateLimit, requestId }
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
