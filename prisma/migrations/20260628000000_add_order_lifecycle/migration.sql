-- Order lifecycle fields for ESIMPurchase
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "previousStatus" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerErrorCode" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerErrorMessage" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerReservationId" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerFulfillId" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "maxRetries" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "lastRetryAt" TIMESTAMP(3);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "retryReason" TEXT;

-- OrderTimelineEvent table
CREATE TABLE IF NOT EXISTS "order_timeline_events" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "oldStatus" TEXT,
  "newStatus" TEXT,
  "message" TEXT,
  "metadata" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_timeline_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_timeline_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "order_timeline_events_orderId_createdAt_idx" ON "order_timeline_events"("orderId", "createdAt");

-- FK for providerId on esim_purchases
DO $$ BEGIN
  ALTER TABLE "esim_purchases" ADD CONSTRAINT "esim_purchases_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- Add orderId to wallet_transactions for order-linked ledger entries
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
