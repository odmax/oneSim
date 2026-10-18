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
  SYNC_RETRY_EXHAUSTED: 'Automatic eSIM status/usage sync retries are exhausted. Run a manual status refresh or check provider connectivity.',
  STUCK_ORDER: 'Orders are stuck in processing state. Review orders queue.',
}

export interface ProviderAlert {
  code: string
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
  message: string
  recommendedAction?: string
}

/**
 * Optional resource identity for alert deduplication/recovery.
 *
 * Without identity the alert is provider-wide (resourceType/resourceId/dedupKey
 * are empty strings): exactly the legacy `(providerId, code)` semantics. With an
 * identity the unresolved uniqueness becomes
 * `(providerId, code, resourceType, resourceId, dedupKey)` — so eSIM-level
 * alerts distinguish eSIM identity AND sync type without encoding identifiers
 * into the human-readable `code`.
 *
 * `resourceId` is the INTERNAL eSIM id (never a masked/raw ICCID); masked ICCIDs
 * belong only in display text. `dedupKey` separates operations on the same
 * resource (e.g. `status` vs `usage` sync exhaustion).
 */
export interface ProviderAlertResource {
  resourceType?: string
  resourceId?: string
  dedupKey?: string
}

/**
 * Empty identity = provider-wide alert (legacy semantics preserved).
 * The DB columns are TEXT DEFAULT '' and de-duplicated via the partial unique
 * index (see the migration) so NULL values never leak in.
 */
function resourceColumns(resource?: ProviderAlertResource): { resourceType: string; resourceId: string; dedupKey: string } {
  return {
    resourceType: resource?.resourceType || '',
    resourceId: resource?.resourceId || '',
    dedupKey: resource?.dedupKey || '',
  }
}

/**
 * Upsert an alert. Unresolved uniqueness is
 * `(providerId, code, resourceType, resourceId, dedupKey)` (partial unique
 * index WHERE resolvedAt IS NULL), so per-resource alerts are independently
 * deduplicated and recovered while provider-wide alerts keep their legacy
 * semantics (empty identity).
 *
 * Alerts are observational: every store error is swallowed so an alert can
 * NEVER break the purchase/synchronization execution path. A structured
 * [PROVIDER_ALERT] line is emitted as the LOG_METRIC channel for monitoring.
 */
export async function upsertProviderAlert(providerId: string, alert: ProviderAlert, resource?: ProviderAlertResource): Promise<void> {
  try {
    const action = RECOMMENDED_ACTIONS[alert.code]
    const r = resourceColumns(resource)

    await prisma.$executeRawUnsafe(`
      INSERT INTO provider_alerts ("id","providerId","code","severity","message","firstSeenAt","lastSeenAt","recommendedAction","occurrenceCount","metadata","resourceType","resourceId","dedupKey","createdAt","updatedAt")
      VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW(), $5, 1, $6::jsonb, $7, $8, $9, NOW(), NOW())
      ON CONFLICT ("providerId","code","resourceType","resourceId","dedupKey") WHERE "resolvedAt" IS NULL
      DO UPDATE SET "lastSeenAt" = NOW(), "occurrenceCount" = provider_alerts."occurrenceCount" + 1, "message" = EXCLUDED.message, "updatedAt" = NOW()
    `, providerId, alert.code, alert.severity, alert.message?.substring(0, 500), action || null, JSON.stringify({ timestamp: new Date().toISOString() }), r.resourceType, r.resourceId, r.dedupKey)

    console.warn(`[PROVIDER_ALERT] providerId=${providerId} code=${alert.code} severity=${alert.severity} resourceType=${r.resourceType || 'provider'} resourceId=${r.resourceId || '-'} dedupKey=${r.dedupKey || '-'} message=${alert.message?.substring(0, 200)}`)
  } catch {}
}

/**
 * Auto-resolve an alert (recovery). Without a resource this closes the
 * provider-wide alert (empty identity) only — it can never resolve another
 * eSIM's resource-scoped alert. With a resource it closes exactly that
 * (provider, code, resourceType, resourceId, dedupKey) row.
 */
export async function resolveProviderAlert(providerId: string, code: string, resource?: ProviderAlertResource): Promise<void> {
  try {
    const r = resourceColumns(resource)
    await prisma.$executeRawUnsafe(
      `UPDATE provider_alerts SET "resolvedAt" = NOW(), "updatedAt" = NOW() WHERE "providerId"=$1 AND code=$2 AND "resolvedAt" IS NULL AND "resourceType"=$3 AND "resourceId"=$4 AND "dedupKey"=$5`,
      providerId, code, r.resourceType, r.resourceId, r.dedupKey
    )
    console.info(`[PROVIDER_ALERT_RESOLVED] providerId=${providerId} code=${code} resourceType=${r.resourceType || 'provider'} resourceId=${r.resourceId || '-'} dedupKey=${r.dedupKey || '-'}`)
  } catch {}
}

/**
 * Get all unresolved alerts for a provider.
 */
export async function getUnresolvedAlerts(providerId: string): Promise<{ code: string; severity: string; message: string; occurrenceCount: number; firstSeenAt: Date }[]> {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT code, severity, message, "occurrenceCount", "firstSeenAt" FROM provider_alerts WHERE "providerId"=$1 AND "resolvedAt" IS NULL ORDER BY severity DESC, "firstSeenAt" DESC`,
      providerId
    ) as any
  } catch {
    return []
  }
}
