-- Resource-scoped provider alert deduplication / recovery.
--
-- Adds an optional resource identity so eSIM-level alerts (SYNC_RETRY_EXHAUSTED)
-- are deduplicated AND recovered independently per (resourceType, resourceId,
-- dedupKey = sync type), while provider-wide alerts keep their legacy semantics.
--
-- Safety audit (deployment concerns):
--  - Existing index name: the partial unique index
--    "provider_alerts_provider_code_unresolved" (providerId, code) WHERE
--    "resolvedAt" IS NULL is dropped and recreated at 5 columns. The original
--    unique index already forbade unresolved duplicate (providerId, code) rows,
--    so no pre-existing provider-wide duplicate can cause the CREATE to fail.
--  - Deterministic empty-identity backfill: every row with any NULL identity
--    column is set to '' (empty string) — the legacy provider-wide sentinel.
--    After this UPDATE no identity column can be NULL, so the unique index
--    treats all provider-wide rows as (providerId, code, '', '', '').
--  - Provider-wide alerts remain unique under the new index: two provider-wide
--    rows with the same (providerId, code) would collide on the 5-column key.
--  - Resource-scoped alerts are isolated: distinct (resourceType, resourceId,
--    dedupKey) are distinct keys and never collide with provider-wide rows.
--  - Transaction/atomicity: Prisma Migrate does NOT auto-wrap PostgreSQL
--    migration files, so atomicity is provided by the EXPLICIT SQL transaction
--    boundaries below (BEGIN ... COMMIT). Column adds, backfill, old-index DROP
--    and new-index CREATE commit together; a failure rolls the whole file back
--    to the previous schema/index state. (CREATE INDEX CONCURRENTLY is
--    intentionally NOT used: it cannot run inside a transaction.) No downgrade
--    is required.
--
-- ────────────────────────────────────────────────────────────────────────────
-- ROLLOUT PREFLIGHT (read-only, run BEFORE `prisma migrate deploy`):
--   -- unresolved provider-alert duplicate groups (expected: 0, enforced by the
--   -- pre-existing unique index; audit confirms no drift):
--   SELECT "providerId", code, COUNT(*) AS unresolved
--   FROM provider_alerts
--   WHERE "resolvedAt" IS NULL
--   GROUP BY "providerId", code
--   HAVING COUNT(*) > 1;
--   -- rows with NULL identity columns that the backfill will normalize
--   -- (expected: 0 once the columns exist; audit confirms count matches):
--   SELECT COUNT(*) FROM provider_alerts
--   WHERE "resourceType" IS NULL OR "resourceId" IS NULL OR "dedupKey" IS NULL;
-- The queries above are NOT executed, queried, or written during this
-- coding-agent task.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE "provider_alerts" ADD COLUMN IF NOT EXISTS "resourceType" TEXT;
ALTER TABLE "provider_alerts" ADD COLUMN IF NOT EXISTS "resourceId" TEXT;
ALTER TABLE "provider_alerts" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;

-- Deterministic empty-identity backfill (never NULL after this statement).
UPDATE "provider_alerts"
SET "resourceType" = '',
    "resourceId" = '',
    "dedupKey" = ''
WHERE "resourceType" IS NULL OR "resourceId" IS NULL OR "dedupKey" IS NULL;

DROP INDEX IF EXISTS "provider_alerts_provider_code_unresolved";

CREATE UNIQUE INDEX IF NOT EXISTS "provider_alerts_provider_code_unresolved"
  ON "provider_alerts"("providerId", "code", "resourceType", "resourceId", "dedupKey")
  WHERE "resolvedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "provider_alerts_providerId_idx" ON "provider_alerts"("providerId");

COMMIT;