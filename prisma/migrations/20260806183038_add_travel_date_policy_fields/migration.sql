-- Add canonical travel-date / activation-policy fields to ProviderPackage
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "activationPolicy" TEXT DEFAULT 'IMMEDIATE';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "travelDateRequirement" TEXT DEFAULT 'NOT_REQUIRED';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "travelDateLeadDays" INTEGER DEFAULT 0;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "travelDateMaxAdvanceDays" INTEGER;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "travelDateSource" TEXT;
