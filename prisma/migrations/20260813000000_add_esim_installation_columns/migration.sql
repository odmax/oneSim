-- Installation/QR data columns on eSIM (normalized provider install payload)
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "qrCode" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "smdpAddress" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "matchingId" TEXT;
