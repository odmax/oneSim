-- Add iBASIS Phase 3 subscriber linkage fields
-- Idempotent — safe to run regardless of existing state

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "providerSubscriberId" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "providerMetadata" JSONB;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "providerSubscriberId" TEXT;
