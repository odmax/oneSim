-- Ensure all ESIM columns exist (safe for production — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- Fields added by activation detection (commit 270ec53)
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "lastUsageAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "activationDetectedAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "lastStatusSyncAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "sharedAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "sharedToEmail" TEXT;

-- Fields added by package snapshot (commit 465899c)
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageSnapshot" JSONB;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageName" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageDataGB" INTEGER;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageValidityDays" INTEGER;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageUnitPrice" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageCurrency" TEXT;

ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageSnapshot" JSONB;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageName" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageDataGB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageValidityDays" INTEGER;

-- Fields added by archive (commit 270ec53 and later)
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "hiddenFromCatalog" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerPackageId" TEXT;

-- Top-up and usage fields (prior to activation detection) 
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataUsedMB" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataRemainingMB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataTotalMB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "lastUsageSyncAt" TIMESTAMP(3);

ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "dataTotalMB" INTEGER;
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "dataRemainingMB" INTEGER;

-- Product type and top-up fields
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT 'NEW_ESIM';
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpQuantity" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpDays" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpOccurrences" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "compatibleTopUpPackageIds" JSONB;

-- Invoice topUpId link
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "topUpId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_topUpId_key" ON "invoices"("topUpId");

-- Provider Webhook Events table
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
CREATE INDEX IF NOT EXISTS "provider_webhook_events_providerType_idx" ON "provider_webhook_events"("providerType");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_eventType_idx" ON "provider_webhook_events"("eventType");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_iccid_idx" ON "provider_webhook_events"("iccid");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_imsi_idx" ON "provider_webhook_events"("imsi");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_esimId_idx" ON "provider_webhook_events"("esimId");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_businessId_idx" ON "provider_webhook_events"("businessId");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_status_idx" ON "provider_webhook_events"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "provider_webhook_events_providerType_externalEventId_key" ON "provider_webhook_events"("providerType", "externalEventId");

-- ESIMShareToken table
CREATE TABLE IF NOT EXISTS "esim_share_tokens" (
    "id" TEXT NOT NULL,
    "esimId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    CONSTRAINT "esim_share_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "esim_share_tokens_token_key" ON "esim_share_tokens"("token");

-- ESIMTopUp table
CREATE TABLE IF NOT EXISTS "esim_top_ups" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "esimId" TEXT NOT NULL,
    "customerId" TEXT,
    "packageId" TEXT NOT NULL,
    "providerId" TEXT,
    "providerReference" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dataAddedMB" INTEGER,
    "validityDaysAdded" INTEGER,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "esim_top_ups_pkey" PRIMARY KEY ("id")
);

-- Customers table (missing from migration chain — added here for fresh DB deployments)
CREATE TABLE IF NOT EXISTS "customers" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "customers_businessId_idx" ON "customers"("businessId");

-- Foreign keys for Customers (safe DO block — PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- Enums (CREATE TYPE IF NOT EXISTS is not supported; use DO blocks)
DO $$ BEGIN
  CREATE TYPE "ProductType" AS ENUM ('NEW_ESIM', 'TOP_UP', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ESIMTopUpStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Foreign keys for ESIMTopUp (safe DO blocks)
DO $$ BEGIN
  ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_esimId_fkey"
    FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- Foreign key for Invoice.topUpId (safe DO block)
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_topUpId_fkey"
    FOREIGN KEY ("topUpId") REFERENCES "esim_top_ups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- Foreign keys for ESIMShareToken
DO $$ BEGIN
  ALTER TABLE "esim_share_tokens" ADD CONSTRAINT "esim_share_tokens_esimId_fkey"
    FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- Foreign keys for ProviderWebhookEvent (optional — no direct FK references needed)

-- Update FK on esims to use RESTRICT instead of CASCADE
ALTER TABLE "esims" DROP CONSTRAINT IF EXISTS "esims_purchaseId_fkey";
ALTER TABLE "esims" ADD CONSTRAINT "esims_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "esim_purchases"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Update FK on esim_purchases to use RESTRICT instead of CASCADE
ALTER TABLE "esim_purchases" DROP CONSTRAINT IF EXISTS "esim_purchases_packageId_fkey";
ALTER TABLE "esim_purchases" ADD CONSTRAINT "esim_purchases_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Update FK on esim_top_ups to use RESTRICT
ALTER TABLE "esim_top_ups" DROP CONSTRAINT IF EXISTS "esim_top_ups_packageId_fkey";
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
