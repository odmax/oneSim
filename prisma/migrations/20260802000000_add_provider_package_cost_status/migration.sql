-- Add provider package cost normalization fields (Phase 5C)
-- All statements are idempotent — safe to run regardless of existing state

ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "costStatus" TEXT DEFAULT 'MISSING';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "costReceivedAt" TIMESTAMP(3);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "costExpiresAt" TIMESTAMP(3);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "isTaxInclusive" BOOLEAN DEFAULT false;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(18,6);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "costDerivationMethod" TEXT;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "costDerivationConfig" JSONB;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "pricingStatus" TEXT DEFAULT 'COST_UNAVAILABLE';
