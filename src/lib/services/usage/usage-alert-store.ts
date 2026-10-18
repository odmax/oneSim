import { prisma } from '@/lib/prisma'

/**
 * Atomic, race-safe persistence for usage alerts.
 *
 * A read-before-create check is NOT sufficient for concurrent schedulers. The
 * canonical guarantee is a database partial unique index:
 *
 *   UNIQUE (esimId, alertType) WHERE "acknowledgedAt" IS NULL
 *
 * (see prisma/migrations/*_add_usage_alerts_dedup/migration.sql — the Prisma
 * schema cannot model partial indexes, so it is intentionally mirrored as a raw
 * migration like provider_alerts). With that index installed, two concurrent
 * attempts to create the same unresolved alert for one eSIM cannot both
 * succeed: exactly one INSERT wins and the other is a no-op.
 */

export const USAGE_ALERT_INSERT_SQL = `
  INSERT INTO usage_alerts ("id","esimId","alertType","severity","message","acknowledgedAt","acknowledgedBy","createdAt")
  VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, NULL, NOW())
  ON CONFLICT ("esimId","alertType") WHERE "acknowledgedAt" IS NULL
  DO NOTHING
`

/** Race-safe create. Returns true only when a new unresolved alert was created. */
export async function insertUsageAlertIfAbsent(input: { esimId: string; alertType: string; severity: string; message: string }): Promise<boolean> {
  try {
    const changes = await prisma.$executeRawUnsafe(USAGE_ALERT_INSERT_SQL, input.esimId, input.alertType, input.severity, input.message)
    return changes > 0
  } catch {
    return false
  }
}

/**
 * Close (resolve) all unresolved alerts of a type for an eSIM by marking them
 * acknowledged. Used for threshold progression (creating a higher tier closes
 * lower tiers) and for authoritative replenishment recovery (usage returning
 * above the threshold closes the percentage/exhausted alerts). Alerts never
 * break the execution path.
 */
export async function resolveUsageAlertType(esimId: string, alertType: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE usage_alerts SET "acknowledgedAt" = NOW(), "acknowledgedBy" = 'SYSTEM' WHERE "esimId"=$1 AND "alertType"=$2 AND "acknowledgedAt" IS NULL`,
      esimId, alertType
    )
  } catch {}
}

/** USAGE percentage tiers; a higher tier closes the lower tiers. */
export const USAGE_THRESHOLD_TIERS: Record<string, number> = {
  USAGE_80: 80,
  USAGE_90: 90,
  USAGE_100: 100,
}

/** Lower-tier threshold types resolved when a given tier is created. */
export function lowerUsageTiers(type: string): string[] {
  const own = USAGE_THRESHOLD_TIERS[type]
  if (own == null) return []
  return Object.entries(USAGE_THRESHOLD_TIERS)
    .filter(([t, v]) => v < own)
    .map(([t]) => t)
}