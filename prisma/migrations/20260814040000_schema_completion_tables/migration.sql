-- Schema completion — TABLES: modeled tables missing from the migration chain.
--
-- These Prisma models exist in schema.prisma but no migration ever created their
-- tables (production has them only via db-push drift). CREATE TABLE IF NOT EXISTS
-- is therefore a safe no-op on the existing production schema. Column types and
-- constraints are generated directly from schema.prisma via `prisma migrate diff`.
--
-- No applied migration is modified; checksums preserved. Nothing is dropped.

-- ── 1. Enums required by the missing tables ──
DO $$ BEGIN CREATE TYPE "ScheduleFrequency" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'CUSTOM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PipelineRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ReviewItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'IGNORED', 'APPLIED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. rule_executions ──
CREATE TABLE IF NOT EXISTS "rule_executions" (
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
CREATE INDEX IF NOT EXISTS "rule_executions_ruleId_idx" ON "rule_executions"("ruleId");
CREATE INDEX IF NOT EXISTS "rule_executions_executedAt_idx" ON "rule_executions"("executedAt");
CREATE INDEX IF NOT EXISTS "rule_executions_status_idx" ON "rule_executions"("status");

-- ── 3. usage_sessions ──
CREATE TABLE IF NOT EXISTS "usage_sessions" (
    "id" TEXT NOT NULL,
    "esimId" TEXT NOT NULL,
    "sessionId" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationSec" INTEGER,
    "dataUsedMB" INTEGER,
    "country" TEXT,
    "operator" TEXT,
    "network" TEXT,
    "cost" DECIMAL(65,30),
    "currency" TEXT,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "usage_sessions_esimId_startTime_idx" ON "usage_sessions"("esimId", "startTime");

-- ── 4. usage_alerts ──
CREATE TABLE IF NOT EXISTS "usage_alerts" (
    "id" TEXT NOT NULL,
    "esimId" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "usage_alerts_esimId_createdAt_idx" ON "usage_alerts"("esimId", "createdAt");

-- ── 5. provider_sync_schedules ──
CREATE TABLE IF NOT EXISTS "provider_sync_schedules" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "ScheduleFrequency" NOT NULL DEFAULT 'DAILY',
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastRunJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_sync_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_sync_schedules_providerId_key" ON "provider_sync_schedules"("providerId");
CREATE INDEX IF NOT EXISTS "provider_sync_schedules_enabled_nextRunAt_idx" ON "provider_sync_schedules"("enabled", "nextRunAt");

-- ── 6. maintenance_jobs ──
CREATE TABLE IF NOT EXISTS "maintenance_jobs" (
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "metadata" JSONB,
    CONSTRAINT "maintenance_jobs_pkey" PRIMARY KEY ("jobKey")
);

-- ── 7. catalog_pipeline_runs ──
CREATE TABLE IF NOT EXISTS "catalog_pipeline_runs" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "providerCode" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "totalInput" INTEGER NOT NULL DEFAULT 0,
    "totalOutput" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_pipeline_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "catalog_pipeline_runs_providerId_idx" ON "catalog_pipeline_runs"("providerId");
CREATE INDEX IF NOT EXISTS "catalog_pipeline_runs_providerCode_idx" ON "catalog_pipeline_runs"("providerCode");
CREATE INDEX IF NOT EXISTS "catalog_pipeline_runs_status_idx" ON "catalog_pipeline_runs"("status");
CREATE INDEX IF NOT EXISTS "catalog_pipeline_runs_startedAt_idx" ON "catalog_pipeline_runs"("startedAt");

-- ── 8. catalog_pipeline_stages ──
CREATE TABLE IF NOT EXISTS "catalog_pipeline_stages" (
    "id" TEXT NOT NULL,
    "pipelineRunId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "reasonCounts" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalog_pipeline_stages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "catalog_pipeline_stages_pipelineRunId_idx" ON "catalog_pipeline_stages"("pipelineRunId");
CREATE INDEX IF NOT EXISTS "catalog_pipeline_stages_stage_idx" ON "catalog_pipeline_stages"("stage");

-- ── 9. catalog_events ──
CREATE TABLE IF NOT EXISTS "catalog_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerId" TEXT,
    "providerCode" TEXT,
    "packageId" TEXT,
    "comparableKey" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "catalog_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "catalog_events_status_idx" ON "catalog_events"("status");
CREATE INDEX IF NOT EXISTS "catalog_events_comparableKey_idx" ON "catalog_events"("comparableKey");
CREATE INDEX IF NOT EXISTS "catalog_events_createdAt_idx" ON "catalog_events"("createdAt");

-- ── 10. catalog_dead_letters ──
CREATE TABLE IF NOT EXISTS "catalog_dead_letters" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "eventType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalog_dead_letters_pkey" PRIMARY KEY ("id")
);

-- ── 11. pipeline_runs ──
CREATE TABLE IF NOT EXISTS "pipeline_runs" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" "PipelineRunStatus" NOT NULL DEFAULT 'RUNNING',
    "totalPackages" INTEGER NOT NULL DEFAULT 0,
    "newPackages" INTEGER NOT NULL DEFAULT 0,
    "updatedPackages" INTEGER NOT NULL DEFAULT 0,
    "readyForReview" INTEGER NOT NULL DEFAULT 0,
    "needsAttention" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "estimatedRevenueImpact" DOUBLE PRECISION,
    "estimatedProfitImpact" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_runs_idempotencyKey_key" ON "pipeline_runs"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "pipeline_runs_idempotencyKey_idx" ON "pipeline_runs"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "pipeline_runs_createdAt_idx" ON "pipeline_runs"("createdAt");

-- ── 12. catalog_review_items ──
CREATE TABLE IF NOT EXISTS "catalog_review_items" (
    "id" TEXT NOT NULL,
    "pipelineRunId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "providerId" TEXT,
    "providerName" TEXT,
    "classification" TEXT NOT NULL,
    "processingState" TEXT NOT NULL,
    "currentSellingPrice" DOUBLE PRECISION,
    "proposedSellingPrice" DOUBLE PRECISION,
    "currentMarginPercent" DOUBLE PRECISION,
    "proposedMarginPercent" DOUBLE PRECISION,
    "currentProviderId" TEXT,
    "currentProviderName" TEXT,
    "recommendedProviderId" TEXT,
    "recommendedProviderName" TEXT,
    "costDifference" DOUBLE PRECISION,
    "profitDifference" DOUBLE PRECISION,
    "suggestedAction" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reviewStatus" "ReviewItemStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "decision" TEXT,
    "applyResult" TEXT,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "staleReason" TEXT,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "changes" JSONB,
    "warnings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_review_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "catalog_review_items_pipelineRunId_idx" ON "catalog_review_items"("pipelineRunId");
CREATE INDEX IF NOT EXISTS "catalog_review_items_packageId_idx" ON "catalog_review_items"("packageId");
CREATE INDEX IF NOT EXISTS "catalog_review_items_reviewStatus_idx" ON "catalog_review_items"("reviewStatus");
CREATE INDEX IF NOT EXISTS "catalog_review_items_reviewedAt_idx" ON "catalog_review_items"("reviewedAt");
CREATE INDEX IF NOT EXISTS "catalog_review_items_providerId_idx" ON "catalog_review_items"("providerId");
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_review_items_pipelineRunId_packageId_key" ON "catalog_review_items"("pipelineRunId", "packageId");

-- ── 13. provider_wallet_transactions ──
CREATE TABLE IF NOT EXISTS "provider_wallet_transactions" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "providerReference" TEXT,
    "orderId" TEXT,
    "transactionType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balanceBefore" DOUBLE PRECISION,
    "balanceAfter" DOUBLE PRECISION,
    "runningBalance" DOUBLE PRECISION,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_wallet_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_wallet_transactions_fingerprint_key" ON "provider_wallet_transactions"("fingerprint");
CREATE INDEX IF NOT EXISTS "provider_wallet_transactions_providerId_occurredAt_idx" ON "provider_wallet_transactions"("providerId", "occurredAt");
CREATE INDEX IF NOT EXISTS "provider_wallet_transactions_fingerprint_idx" ON "provider_wallet_transactions"("fingerprint");

-- ── 14. Foreign keys for the new tables ──
DO $$ BEGIN ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "package_configuration_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "usage_sessions" ADD CONSTRAINT "usage_sessions_esimId_fkey" FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_esimId_fkey" FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "catalog_pipeline_stages" ADD CONSTRAINT "catalog_pipeline_stages_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "catalog_pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
