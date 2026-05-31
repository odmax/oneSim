-- Add ProductType enum for ESIMPackage
CREATE TYPE "ProductType" AS ENUM ('NEW_ESIM', 'TOP_UP', 'BOTH');

-- Add ESIMTopUpStatus enum
CREATE TYPE "ESIMTopUpStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- AlterTable: ESIMPackage - add product type and top-up fields
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "productType" "ProductType" NOT NULL DEFAULT 'NEW_ESIM';
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpQuantity" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpDays" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "topUpOccurrences" INTEGER;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "compatibleTopUpPackageIds" JSONB;

-- AlterTable: ESIM - add usage summary fields
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataUsedMB" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataRemainingMB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "dataTotalMB" INTEGER;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "lastUsageSyncAt" TIMESTAMP(3);

-- AlterTable: UsageRecord - add total/remaining fields
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "dataTotalMB" INTEGER;
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "dataRemainingMB" INTEGER;

-- AlterTable: Invoice - add topUpId link
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "topUpId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_topUpId_key" ON "invoices"("topUpId");

-- CreateTable: ESIMTopUp
CREATE TABLE IF NOT EXISTS "esim_top_ups" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "esimId" TEXT NOT NULL,
    "customerId" TEXT,
    "packageId" TEXT NOT NULL,
    "providerId" TEXT,
    "providerReference" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "ESIMTopUpStatus" NOT NULL DEFAULT 'PENDING',
    "dataAddedMB" INTEGER,
    "validityDaysAdded" INTEGER,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "esim_top_ups_pkey" PRIMARY KEY ("id")
);

-- AddForeignKeys for ESIMTopUp
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_esimId_fkey" FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invoice foreign key for topUpId
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_topUpId_fkey" FOREIGN KEY ("topUpId") REFERENCES "esim_top_ups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
