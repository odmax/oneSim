-- Persistent provider alerts with deduplication
CREATE TABLE IF NOT EXISTS "provider_alerts" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "providerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "message" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "recommendedAction" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_alerts_provider_code_unresolved" ON "provider_alerts"("providerId","code") WHERE "resolvedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "provider_alerts_providerId_idx" ON "provider_alerts"("providerId");
