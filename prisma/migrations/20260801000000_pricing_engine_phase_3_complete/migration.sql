-- Phase 3: Exchange Rates, Price Snapshots & Purchase Quotes
-- All statements are idempotent — safe to run regardless of existing state.

-- Enums
DO $$ BEGIN CREATE TYPE "ExchangeRateSource" AS ENUM ('MANUAL','PROVIDER','EXTERNAL_API','SYSTEM'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ExchangeRateStatus" AS ENUM ('ACTIVE','STALE','DISABLED','INVALID'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PurchaseQuoteStatus" AS ENUM ('ACTIVE','EXPIRED','CONSUMED','INVALIDATED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Exchange Rates
CREATE TABLE IF NOT EXISTS "exchange_rates" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "rate" DECIMAL(24,12) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL,
    "status" "ExchangeRateStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_rates_baseCurrency_quoteCurrency_effectiveAt_key" ON "exchange_rates"("baseCurrency","quoteCurrency","effectiveAt");
CREATE INDEX IF NOT EXISTS "exchange_rates_baseCurrency_quoteCurrency_status_idx" ON "exchange_rates"("baseCurrency","quoteCurrency","status");
CREATE INDEX IF NOT EXISTS "exchange_rates_expiresAt_idx" ON "exchange_rates"("expiresAt");

-- Package Price Snapshots
CREATE TABLE IF NOT EXISTS "package_price_snapshots" (
    "id" TEXT NOT NULL,
    "providerPackageId" TEXT NOT NULL,
    "businessId" TEXT,
    "originalCostAmount" DECIMAL(18,6) NOT NULL,
    "originalCostCurrency" TEXT NOT NULL,
    "effectiveCostAmount" DECIMAL(18,6) NOT NULL,
    "effectiveCostCurrency" TEXT NOT NULL,
    "baseSellingPrice" DECIMAL(18,6) NOT NULL,
    "finalSellingPrice" DECIMAL(18,6) NOT NULL,
    "sellingCurrency" TEXT NOT NULL,
    "profitAmount" DECIMAL(18,6) NOT NULL,
    "marginPercent" DECIMAL(10,4) NOT NULL,
    "providerCostSnapshotId" TEXT,
    "exchangeRateId" TEXT,
    "exchangeRateVersion" INTEGER,
    "pricingEngineVersion" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "package_price_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "package_price_snapshots_providerPackageId_createdAt_idx" ON "package_price_snapshots"("providerPackageId","createdAt");
CREATE INDEX IF NOT EXISTS "package_price_snapshots_status_idx" ON "package_price_snapshots"("status");

-- Purchase Quotes
CREATE TABLE IF NOT EXISTS "purchase_quotes" (
    "id" TEXT NOT NULL,
    "quoteReference" TEXT NOT NULL,
    "providerPackageId" TEXT NOT NULL,
    "packagePriceSnapshotId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "totalAmount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveCostAmount" DECIMAL(18,6) NOT NULL,
    "effectiveCostCurrency" TEXT NOT NULL,
    "providerCostSnapshotId" TEXT,
    "exchangeRateId" TEXT,
    "exchangeRateVersion" INTEGER,
    "pricingEngineVersion" TEXT NOT NULL,
    "status" "PurchaseQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "purchase_quotes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_quotes_quoteReference_key" ON "purchase_quotes"("quoteReference");
CREATE INDEX IF NOT EXISTS "purchase_quotes_businessId_status_idx" ON "purchase_quotes"("businessId","status");
CREATE INDEX IF NOT EXISTS "purchase_quotes_providerPackageId_idx" ON "purchase_quotes"("providerPackageId");
CREATE INDEX IF NOT EXISTS "purchase_quotes_expiresAt_idx" ON "purchase_quotes"("expiresAt");

-- Active Price Snapshot FK on Provider Packages
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "activePriceSnapshotId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "provider_packages_activePriceSnapshotId_key" ON "provider_packages"("activePriceSnapshotId");

-- System Job Locks
CREATE TABLE IF NOT EXISTS "system_job_locks" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "owner" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "system_job_locks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_job_locks_jobName_key" ON "system_job_locks"("jobName");
