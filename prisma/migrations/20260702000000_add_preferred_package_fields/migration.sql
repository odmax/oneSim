-- Add preferred package and auto-pick fields
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "is_preferred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "preferred_reason" TEXT;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "preferred_at" TIMESTAMP(3);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "excluded_from_auto_pick" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "auto_pick_reason" TEXT;
