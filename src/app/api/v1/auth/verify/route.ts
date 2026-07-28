export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) {
    authError.headers.set('X-RateLimit-Limit', String(rateLimit?.limit ?? 60))
    authError.headers.set('X-RateLimit-Remaining', String(rateLimit?.remaining ?? 0))
    return authError
  }

  return respond(request, {
    success: true,
    businessId,
  }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}
