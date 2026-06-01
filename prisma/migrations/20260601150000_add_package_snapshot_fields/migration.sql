-- AlterTable: add package snapshot fields to esim_purchases
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageSnapshot" JSONB;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageName" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageDataGB" INTEGER;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageValidityDays" INTEGER;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageUnitPrice" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "packageCurrency" TEXT;

-- AlterTable: add package snapshot fields to esims
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageSnapshot" JSONB;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageName" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageDataGB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "packageValidityDays" INTEGER;
