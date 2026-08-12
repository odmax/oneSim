-- Provider self-heal history
CREATE TABLE IF NOT EXISTS "provider_self_heal_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "providerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'attempted',
    "errorCode" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_self_heal_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_self_heal_events_providerId_idx" ON "provider_self_heal_events"("providerId", "attemptedAt" DESC);

-- Provider self-heal lease (prevents concurrent workers from healing same provider)
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "selfHealLeaseUntil" TIMESTAMP(3);

-- Endpoint telemetry latency
ALTER TABLE "provider_endpoint_calls" ADD COLUMN IF NOT EXISTS "lastLatencyMs" INTEGER;
ALTER TABLE "provider_endpoint_calls" ADD COLUMN IF NOT EXISTS "totalLatencyMs" BIGINT DEFAULT 0;
ALTER TABLE "provider_endpoint_calls" ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER DEFAULT 0;
