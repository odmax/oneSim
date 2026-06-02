-- Drop cascading foreign keys and recreate with RESTRICT to prevent accidental deletion of commissioned eSIMs.

-- 1. ESIM → ESIMPurchase: RESTRICT instead of CASCADE
ALTER TABLE "esims" DROP CONSTRAINT IF EXISTS "esims_purchaseId_fkey";
ALTER TABLE "esims" ADD CONSTRAINT "esims_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "esim_purchases"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. ESIMTopUp → ESIM: RESTRICT instead of CASCADE (defense-in-depth)
ALTER TABLE "esim_top_ups" DROP CONSTRAINT IF EXISTS "esim_top_ups_esimId_fkey";
ALTER TABLE "esim_top_ups" ADD CONSTRAINT "esim_top_ups_esimId_fkey"
  FOREIGN KEY ("esimId") REFERENCES "esims"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
