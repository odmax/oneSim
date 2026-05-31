-- CreateEnum
-- Note: Additional enums may exist from prior migrations

-- CreateTable: provider_webhook_events
CREATE TABLE IF NOT EXISTS "provider_webhook_events" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "providerType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalEventId" TEXT,
    "iccid" TEXT,
    "imsi" TEXT,
    "esimId" TEXT,
    "businessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "provider_webhook_events_providerType_idx" ON "provider_webhook_events"("providerType");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_eventType_idx" ON "provider_webhook_events"("eventType");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_iccid_idx" ON "provider_webhook_events"("iccid");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_imsi_idx" ON "provider_webhook_events"("imsi");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_esimId_idx" ON "provider_webhook_events"("esimId");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_businessId_idx" ON "provider_webhook_events"("businessId");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_status_idx" ON "provider_webhook_events"("status");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_receivedAt_idx" ON "provider_webhook_events"("receivedAt");

-- Unique constraint for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS "provider_webhook_events_providerType_externalEventId_key" ON "provider_webhook_events"("providerType", "externalEventId");
