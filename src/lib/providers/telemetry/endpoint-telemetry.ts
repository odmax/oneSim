import { prisma } from '@/lib/prisma'

const KNOWN_CHOICE_ENDPOINTS = [
  { operation: 'getaccounts', path: '/WebService/accounts/getaccounts', usedInPool: true },
  { operation: 'bundle_templates', path: '/account/v03_09/bundle_templates/{token}', usedInPool: true },
  { operation: 'add_bundle_using_template_from_pool', path: '/template/v03_09/add_bundle_using_template_from_pool/{token}', usedInPool: true },
  { operation: 'package_detail', path: '/account/v03_09/package_detail/{token}', usedInPool: true },
  { operation: 'suspend_imsi', path: '/account/v03_09/suspend_imsi/{token}', usedInPool: true },
  { operation: 'resume_imsi', path: '/account/v03_09/resume_imsi/{token}', usedInPool: true },
  { operation: 'update_imsi', path: '/account/v03_09/update_imsi/{token}', usedInPool: true },
  { operation: 'roaming_profiles', path: '/account/v03_09/roaming_profiles/{token}', usedInPool: true },
  { operation: 'imsis_from_iccid', path: '/account/v03_09/imsis_from_iccid/{token}?iccid=', usedInPool: false },
  { operation: 'imsi_version', path: '/account/v03_09/imsi_version/{token}', usedInPool: false },
  { operation: 'allocated_imsi_list', path: '/account/v03_09/allocated_imsi_list/{token}', usedInPool: false },
  { operation: 'event_logs', path: '/account/v03_09/event_logs/{token}', usedInPool: false },
  { operation: 'prepaid_rates_list', path: '/account/v03_09/prepaid_rates_list/{token}', usedInPool: false },
  { operation: 'prepaid_balance', path: '/account/v03_09/prepaid_balance/{token}', usedInPool: true },
  { operation: 'threshold_webhook', path: 'Inbound POST (webhook)', usedInPool: true },
]

const DOCUMENTED_UNUSED = [
  { operation: 'add_imsi', reason: 'Not used by current pool-based OneSIM purchase architecture.' },
  { operation: 'imsi_list', reason: 'Not used by current pool-based OneSIM purchase architecture.' },
  { operation: 'create_bundle_template', reason: 'Not used by current pool-based OneSIM purchase architecture.' },
  { operation: 'update_bundle_template', reason: 'Not used by current pool-based OneSIM purchase architecture.' },
  { operation: 'add_bundle_using_template', reason: 'Not used by current pool-based OneSIM purchase architecture.' },
]

export async function recordEndpointCall(providerId: string, operation: string, result: { success: boolean; httpStatus?: number }) {
  const now = new Date()
  await prisma.$executeRawUnsafe(`
    INSERT INTO provider_endpoint_calls ("id", "providerId", "operation", "endpointPath", "lastAttemptedAt", "lastSuccessAt", "lastFailureAt", "lastHttpStatus", "totalCalls", "totalSuccesses", "totalFailures", "updatedAt")
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10)
    ON CONFLICT ("providerId", "operation")
    DO UPDATE SET
      "lastAttemptedAt" = EXCLUDED."lastAttemptedAt",
      "lastSuccessAt" = COALESCE(EXCLUDED."lastSuccessAt", provider_endpoint_calls."lastSuccessAt"),
      "lastFailureAt" = COALESCE(EXCLUDED."lastFailureAt", provider_endpoint_calls."lastFailureAt"),
      "lastHttpStatus" = COALESCE(EXCLUDED."lastHttpStatus", provider_endpoint_calls."lastHttpStatus"),
      "totalCalls" = provider_endpoint_calls."totalCalls" + 1,
      "totalSuccesses" = provider_endpoint_calls."totalSuccesses" + $8,
      "totalFailures" = provider_endpoint_calls."totalFailures" + $9,
      "updatedAt" = EXCLUDED."updatedAt"
  `, providerId, operation, KNOWN_CHOICE_ENDPOINTS.find(e => e.operation === operation)?.path || '', now,
    result.success ? now : null, result.success ? null : now, result.httpStatus || null,
    result.success ? 1 : 0, result.success ? 0 : 1, now)
}

export function getChoiceEndpointCoverage(providerId: string) {
  return KNOWN_CHOICE_ENDPOINTS
}

export function getDocumentedUnusedEndpoints() {
  return DOCUMENTED_UNUSED
}
