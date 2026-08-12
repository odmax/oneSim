import { prisma } from '@/lib/prisma'

const RECOMMENDED_ACTIONS: Record<string, string> = {
  PROVIDER_AUTH_FAILED: 'Re-authenticate provider credentials.',
  PROVIDER_HIGH_FAILURE_RATE: 'Review recent purchase failures and provider diagnostics.',
  PROVIDER_HIGH_LATENCY: 'Monitor provider response times. Consider routing adjustments.',
  CIRCUIT_OPEN: 'Circuit breaker is open. Wait for recovery or manually reset if safe.',
  LOW_PROVIDER_BALANCE: 'Top up provider account or route purchases to alternate providers.',
  INVENTORY_LOW: 'Provider SIM inventory is low. Consider restocking.',
  INVENTORY_EXHAUSTED: 'Provider SIM inventory is exhausted. Purchases will fail.',
  CATALOG_STALE: 'Provider catalog has not been synced recently. Run catalog sync.',
  WEBHOOK_BACKLOG: 'Provider webhook processing has failures. Investigate webhook pipeline.',
  RECONCILIATION_BACKLOG: 'Orders are in reconciliation. Review reconciliation queue.',
  SYNC_FAILURE_SPIKE: 'eSIM status/usage sync failures detected. Check provider connectivity.',
  STUCK_ORDER: 'Orders are stuck in processing state. Review orders queue.',
}

export interface ProviderAlert {
  code: string
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
  message: string
  recommendedAction?: string
}

/**
 * Upsert an alert. Deduplicates by (providerId, code) when unresolved.
 * Auto-resolves previous unresolved occurrences by code before inserting new.
 */
export async function upsertProviderAlert(providerId: string, alert: ProviderAlert): Promise<void> {
  const action = RECOMMENDED_ACTIONS[alert.code]

  await prisma.$executeRawUnsafe(`
    INSERT INTO provider_alerts ("id","providerId","code","severity","message","firstSeenAt","lastSeenAt","recommendedAction","occurrenceCount","metadata","createdAt","updatedAt")
    VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW(), $5, 1, $6::jsonb, NOW(), NOW())
    ON CONFLICT ("providerId","code") WHERE "resolvedAt" IS NULL
    DO UPDATE SET "lastSeenAt" = NOW(), "occurrenceCount" = provider_alerts."occurrenceCount" + 1, "message" = EXCLUDED.message, "updatedAt" = NOW()
  `, providerId, alert.code, alert.severity, alert.message?.substring(0, 500), action || null, JSON.stringify({ timestamp: new Date().toISOString() })).catch(() => {})
}

/**
 * Auto-resolve an alert by code.
 */
export async function resolveProviderAlert(providerId: string, code: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE provider_alerts SET "resolvedAt" = NOW(), "updatedAt" = NOW() WHERE "providerId"=$1 AND code=$2 AND "resolvedAt" IS NULL`,
    providerId, code
  ).catch(() => {})
}

/**
 * Get all unresolved alerts for a provider.
 */
export async function getUnresolvedAlerts(providerId: string): Promise<{ code: string; severity: string; message: string; occurrenceCount: number; firstSeenAt: Date }[]> {
  return prisma.$queryRawUnsafe(
    `SELECT code, severity, message, "occurrenceCount", "firstSeenAt" FROM provider_alerts WHERE "providerId"=$1 AND "resolvedAt" IS NULL ORDER BY severity DESC, "firstSeenAt" DESC`,
    providerId
  ).catch(() => []) as any
}
