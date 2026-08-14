-- Restored historical migration.
--
-- This migration was applied to deployed databases (production + staging) but
-- was never committed to the Git tree. It was recovered verbatim from the
-- applied deployment history (the RuleExecution model's canonical schema):
-- it created the rule_executions table, its three indexes, and its two FKs.
--
-- It is being restored to the canonical migration tree so the deployed
-- _prisma_migrations history matches the repository (prisma migrate deploy
-- treats an already-recorded migration as applied and will NOT re-run it on
-- production/staging). On a brand-new database it runs once, before the guarded
-- 20260814040000_schema_completion_tables migration, whose
-- CREATE TABLE IF NOT EXISTS "rule_executions" then safely no-ops.

CREATE TABLE "rule_executions" (
  "id" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "ruleName" TEXT NOT NULL,
  "executedById" TEXT,
  "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "scope" TEXT NOT NULL,
  "filtersUsed" JSONB,
  "totalMatched" INTEGER NOT NULL DEFAULT 0,
  "updatedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "skipDetails" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "rule_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rule_executions_ruleId_idx" ON "rule_executions"("ruleId");
CREATE INDEX "rule_executions_executedAt_idx" ON "rule_executions"("executedAt");
CREATE INDEX "rule_executions_status_idx" ON "rule_executions"("status");

ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "package_configuration_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
