-- Drop foreign keys that cascade delete from ESIMPackage → ESIMPurchase and ESIMPackage → ESIMTopUp
-- and recreate them with RESTRICT to prevent accidental cascade deletion of purchased eSIMs.

ALTER TABLE "esim_purchases" DROP CONSTRAINT IF EXISTS "esim_purchases_packageId_fkey",
ADD CONSTRAINT "esim_purchases_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "esim_top_ups" DROP CONSTRAINT IF EXISTS "esim_top_ups_packageId_fkey",
ADD CONSTRAINT "esim_top_ups_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
