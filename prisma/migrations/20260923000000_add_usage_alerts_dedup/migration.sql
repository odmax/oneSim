-- Race-safe deduplication for usage alerts.
--
-- There are two halves:
--   1) A DETERMINISTIC, idempotent pre-dedupe that collapses any pre-existing
--      duplicate UNRESOLVED rows created by the earlier read-then-create
--      implementation. Without it, CREATE UNIQUE INDEX below would fail on an
--      existing database.
--   2) The partial unique index enforcing "at most ONE unresolved alert per
--      (eSIM, alertType)" going forward.
--
-- Retention rule (canonical row): KEEP THE NEWEST unresolved alert per
-- (esimId, alertType) group. Stable ordering is ("createdAt" ASC, "id" ASC);
-- "id" (cuid, globally unique) is the deterministic tiebreaker for rows sharing
-- an identical "createdAt". Every OLDER unresolved member of the group is
-- marked acknowledged (resolved) — never deleted, history preserved.
--
-- Deterministic  : the predicate is a strict total order over (createdAt, id).
-- Idempotent     : once a group has zero duplicate unresolved rows, re-running
--                  matches nothing (acknowledged rows are excluded).
-- Transaction    : atomicity is provided by the EXPLICIT SQL transaction
--                  boundaries below (BEGIN ... COMMIT). Prisma Migrate does NOT
--                  auto-wrap PostgreSQL migration files in a transaction, so
--                  the dedupe and the index creation commit together only
--                  because of these boundaries. A failure rolls both back.
--                  (CREATE INDEX CONCURRENTLY is intentionally NOT used: it
--                  cannot run inside a transaction.)
-- No duplicates  : the UPDATE simply matches nothing.
-- Index exists   : `IF NOT EXISTS` is safe to re-run.
-- Isolation      : the self-join is scoped to the same (esimId, alertType);
--                  rows of other eSIMs / alert types are never touched.

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLOUT PREFLIGHT (read-only, run BEFORE `prisma migrate deploy`):
--   SELECT "esimId", "alertType", COUNT(*) AS unresolved
--   FROM usage_alerts
--   WHERE "acknowledgedAt" IS NULL
--   GROUP BY "esimId", "alertType"
--   HAVING COUNT(*) > 1
--   ORDER BY unresolved DESC;
-- The count above must be audited and accepted before migrating. The addresses
-- below are NOT run, queried, or written during this coding-agent task.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Collapse existing duplicates: mark every unresolved row that has a
--    STRICTLY NEWER unresolved sibling in the same (esimId, alertType) group
--    as acknowledged. The newest row of each group has no such sibling and
--    stays unresolved (canonical).
UPDATE usage_alerts AS dupe
SET "acknowledgedAt" = NOW(), "acknowledgedBy" = 'SYSTEM'
WHERE dupe."acknowledgedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM usage_alerts AS newer
    WHERE newer."esimId" = dupe."esimId"
      AND newer."alertType" = dupe."alertType"
      AND newer."acknowledgedAt" IS NULL
      AND (newer."createdAt" > dupe."createdAt"
           OR (newer."createdAt" = dupe."createdAt" AND newer."id" > dupe."id"))
  );

-- 2) Enforce the invariant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "usage_alerts_esim_type_unresolved"
  ON "usage_alerts"("esimId", "alertType") WHERE "acknowledgedAt" IS NULL;

COMMIT;