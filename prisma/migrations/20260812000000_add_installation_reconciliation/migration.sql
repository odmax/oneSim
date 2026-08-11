-- QR/Installation reconciliation fields on eSIM
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "installationStatus" TEXT DEFAULT 'PENDING';
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "installationRetryCount" INTEGER DEFAULT 0;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "installationLastCheckedAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "installationLastError" TEXT;
