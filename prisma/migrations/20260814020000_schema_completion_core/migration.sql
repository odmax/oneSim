-- Schema completion — CORE: enums, missing columns, and type alignment.
--
-- Generated from `prisma migrate diff` between a fresh replayed DB (migration
-- chain only) and prisma/schema.prisma. All statements are additive/guarded and
-- are safe no-ops on the existing drifted production schema (which already
-- matches schema.prisma via db-push drift). No applied migration is modified,
-- so every Prisma migration checksum is preserved.
--
-- This migration only touches ENUMS, ADD COLUMN, type conversions, defaults,
-- and NOT NULL fixes. Table/column renames and missing-table creation are in the
-- sibling schema-completion migrations.

-- ── 1. Enum completions (runtime-critical: background_jobs.type/status) ──
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROVIDER_OPERATION';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROVIDER_SYNC';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'CATALOG_PIPELINE';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'REVIEW_REBUILD';

-- ── 2. background_jobs: missing Phase-4B hardening columns ──
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "cancellationRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3);
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "metricsData" JSONB;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "progress" INTEGER;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "resultsData" JSONB;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "retryBackoffMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "retryClassification" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "scheduleId" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "staleReason" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "triggerSource" TEXT;
ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "workerId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "background_jobs_idempotencyKey_key" ON "background_jobs"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "background_jobs_idempotencyKey_idx" ON "background_jobs"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "background_jobs_providerId_status_idx" ON "background_jobs"("providerId", "status");

-- ── 3. esim_purchases: providerPurchaseKey rename + partial-fulfillment NOT NULL ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='esim_purchases' AND column_name='provider_purchase_key')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='esim_purchases' AND column_name='providerPurchaseKey') THEN
    ALTER TABLE "esim_purchases" RENAME COLUMN "provider_purchase_key" TO "providerPurchaseKey";
  END IF;
END $$;
UPDATE "esim_purchases" SET "fulfilledQuantity" = 0 WHERE "fulfilledQuantity" IS NULL;
UPDATE "esim_purchases" SET "failedQuantity" = 0 WHERE "failedQuantity" IS NULL;
ALTER TABLE "esim_purchases" ALTER COLUMN "fulfilledQuantity" SET NOT NULL;
ALTER TABLE "esim_purchases" ALTER COLUMN "failedQuantity" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "esim_purchases_providerPurchaseKey_key" ON "esim_purchases"("providerPurchaseKey");
DROP INDEX IF EXISTS "idx_esim_purchases_status_next_retry";
DROP INDEX IF EXISTS "idx_esim_purchases_status_updated";
DROP INDEX IF EXISTS "esim_purchases_purchaseQuoteId_idx";
DROP INDEX IF EXISTS "esim_purchases_packagePriceSnapshotId_idx";

-- ── 4. esims: status enum -> TEXT; retry counters NOT NULL ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='esims' AND column_name='status' AND data_type='USER-DEFINED') THEN
    ALTER TABLE "esims" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "esims" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
    ALTER TABLE "esims" ALTER COLUMN "status" SET DEFAULT 'PENDING';
  END IF;
END $$;
UPDATE "esims" SET "installationRetryCount" = 0 WHERE "installationRetryCount" IS NULL;
UPDATE "esims" SET "statusSyncRetryCount" = 0 WHERE "statusSyncRetryCount" IS NULL;
UPDATE "esims" SET "usageSyncRetryCount" = 0 WHERE "usageSyncRetryCount" IS NULL;
ALTER TABLE "esims" ALTER COLUMN "installationRetryCount" SET NOT NULL;
ALTER TABLE "esims" ALTER COLUMN "statusSyncRetryCount" SET NOT NULL;
ALTER TABLE "esims" ALTER COLUMN "usageSyncRetryCount" SET NOT NULL;

-- ── 5. invoices: status enum -> TEXT; taxTotal rename ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='status' AND data_type='USER-DEFINED') THEN
    ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "invoices" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
    ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='tax_total')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='taxTotal') THEN
    ALTER TABLE "invoices" RENAME COLUMN "tax_total" TO "taxTotal";
  END IF;
END $$;

-- ── 6. wallet_transactions: type enum -> TEXT (Option A billing preserved) ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wallet_transactions' AND column_name='type' AND data_type='USER-DEFINED') THEN
    ALTER TABLE "wallet_transactions" ALTER COLUMN "type" TYPE TEXT USING "type"::text;
  END IF;
END $$;

-- ── 7. users: passwordHash nullable per schema ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='passwordHash' AND is_nullable='NO') THEN
    ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
  END IF;
END $$;

-- ── 8. usage_records: missing columns + index ──
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "dataPercentage" DOUBLE PRECISION;
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "rawData" JSONB;
CREATE INDEX IF NOT EXISTS "usage_records_esimId_timestamp_idx" ON "usage_records"("esimId", "timestamp");

-- ── 9. business_api_keys: expiresAt rename + environment NOT NULL ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='business_api_keys' AND column_name='expires_at')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='business_api_keys' AND column_name='expiresAt') THEN
    ALTER TABLE "business_api_keys" RENAME COLUMN "expires_at" TO "expiresAt";
  END IF;
END $$;
UPDATE "business_api_keys" SET "environment" = 'production' WHERE "environment" IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='business_api_keys' AND column_name='environment' AND is_nullable='YES') THEN
    ALTER TABLE "business_api_keys" ALTER COLUMN "environment" SET NOT NULL;
  END IF;
END $$;

-- ── 10. order_callback_deliveries: signatureVersion NOT NULL; updatedAt default ──
UPDATE "order_callback_deliveries" SET "signatureVersion" = 'v1' WHERE "signatureVersion" IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_callback_deliveries' AND column_name='signatureVersion' AND is_nullable='YES') THEN
    ALTER TABLE "order_callback_deliveries" ALTER COLUMN "signatureVersion" SET NOT NULL;
  END IF;
END $$;
ALTER TABLE "order_callback_deliveries" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- ── 11. provider_health_snapshots / provider_inventory_reservations: defaults ──
ALTER TABLE "provider_health_snapshots" ALTER COLUMN "lastCheckAt" DROP DEFAULT;
ALTER TABLE "provider_inventory_reservations" ALTER COLUMN "requestedQuantity" DROP DEFAULT;
ALTER TABLE "provider_inventory_reservations" ALTER COLUMN "expiresAt" DROP DEFAULT;
ALTER TABLE "provider_inventory_reservations" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- ── 12. provider_cost_snapshots / provider_package_fees: DECIMAL width ──
ALTER TABLE "provider_cost_snapshots" ALTER COLUMN "originalAmount" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "provider_cost_snapshots" ALTER COLUMN "normalizedAmount" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "provider_cost_snapshots" ALTER COLUMN "exchangeRate" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "provider_cost_snapshots" ALTER COLUMN "taxAmount" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "provider_package_fees" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(65,30);

-- ── 13. providers: type default removed per schema ──
ALTER TABLE "providers" ALTER COLUMN "type" DROP DEFAULT;
