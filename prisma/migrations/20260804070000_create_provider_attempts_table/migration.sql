-- ProviderAttempt table repair.
--
-- The ProviderAttempt model exists in schema.prisma and is referenced by the
-- operations-indexes migration (20260804072604), but no migration in the chain
-- ever created the table. Legacy databases have it only because of schema drift
-- (db push). This migration creates it, timestamped before 20260804072604, so a
-- fresh replay of the full chain succeeds and matches schema.prisma.
--
-- Columns match the ProviderAttempt model exactly. No applied migration is
-- modified, so every Prisma migration checksum is preserved.

CREATE TABLE IF NOT EXISTS "provider_attempts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'PURCHASE',
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "retryClassification" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "providerReference" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "provider_attempts_orderId_idx" ON "provider_attempts"("orderId");
CREATE INDEX IF NOT EXISTS "provider_attempts_providerId_idx" ON "provider_attempts"("providerId");
CREATE INDEX IF NOT EXISTS "provider_attempts_status_idx" ON "provider_attempts"("status");
CREATE INDEX IF NOT EXISTS "provider_attempts_startedAt_idx" ON "provider_attempts"("startedAt");
