-- Add scopes, rotation, and environment fields to business_api_keys
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "scopes" TEXT[] DEFAULT '{}';
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "replacedById" TEXT;
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "gracePeriodEndAt" TIMESTAMP(3);
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "environment" TEXT DEFAULT 'production';
