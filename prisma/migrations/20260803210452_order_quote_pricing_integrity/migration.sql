-- Add quote-consumption and immutable-pricing fields to esim_purchases.
-- All new columns are nullable to preserve legacy orders.
-- purchaseQuoteId has a UNIQUE constraint to enforce one-quote-per-order.
-- Foreign keys use ON DELETE SET NULL so orders survive quote/snapshot deletion.

-- 1. Add columns (idempotent — IF NOT EXISTS)
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "purchaseQuoteId" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packagePriceSnapshotId" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "quotedUnitPrice" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "quotedTotalAmount" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "quotedCurrency" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "quotedQuantity" INTEGER;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "pricingEngineVersion" TEXT;

-- 2. Unique constraint on purchaseQuoteId (allows multiple NULLs per PostgreSQL spec)
CREATE UNIQUE INDEX IF NOT EXISTS "esim_purchases_purchaseQuoteId_key" ON "esim_purchases" ("purchaseQuoteId");

-- 3. Performance indexes
CREATE INDEX IF NOT EXISTS "esim_purchases_purchaseQuoteId_idx" ON "esim_purchases" ("purchaseQuoteId");
CREATE INDEX IF NOT EXISTS "esim_purchases_packagePriceSnapshotId_idx" ON "esim_purchases" ("packagePriceSnapshotId");

-- 4. Foreign keys with ON DELETE SET NULL
DO $$ BEGIN
  ALTER TABLE "esim_purchases" ADD CONSTRAINT "esim_purchases_purchaseQuoteId_fkey"
    FOREIGN KEY ("purchaseQuoteId") REFERENCES "purchase_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "esim_purchases" ADD CONSTRAINT "esim_purchases_packagePriceSnapshotId_fkey"
    FOREIGN KEY ("packagePriceSnapshotId") REFERENCES "package_price_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
