ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "readyToPublish" BOOLEAN NOT NULL DEFAULT false;
