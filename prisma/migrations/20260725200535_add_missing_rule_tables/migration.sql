-- CreateTable
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

-- CreateIndex
CREATE INDEX "rule_executions_ruleId_idx" ON "rule_executions"("ruleId");

-- CreateIndex
CREATE INDEX "rule_executions_executedAt_idx" ON "rule_executions"("executedAt");

-- CreateIndex
CREATE INDEX "rule_executions_status_idx" ON "rule_executions"("status");

-- AddForeignKey
ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "package_configuration_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_executions" ADD CONSTRAINT "rule_executions_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

