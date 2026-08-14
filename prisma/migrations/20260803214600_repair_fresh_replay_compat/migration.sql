-- Fresh-replay compatibility repair.
--
-- Historical defect: two migrations reference schema state that only existed in
-- drifted/legacy databases and was never created by the migration chain itself:
--
--   1) esim_purchases.status is created by the init migration as the enum
--      "PurchaseStatus" ('PENDING','COMPLETED','FAILED','CANCELLED'), and no
--      migration ever converts it to TEXT. The partial-fulfillment backfill in
--      20260803214609 then compares `"status" = 'FULFILLED'` and fails on a
--      fresh replay with `invalid input value for enum "PurchaseStatus":
--      "FULFILLED"`.
--   2) esim_top_ups.idempotencyKey is referenced by the unique index created in
--      20260814000000 but the column is never added by any migration.
--
-- This migration is timestamped 20260803214600 so it runs BEFORE both failing
-- migrations on a fresh replay. On already-migrated databases it is a safe no-op
-- (status is already TEXT, idempotencyKey already exists).
--
-- No already-applied migration is modified, so every Prisma migration checksum
-- is preserved.

-- 1) esim_purchases.status: enum "PurchaseStatus" -> TEXT.
--    schema.prisma models ESIMPurchase.status as String. DROP DEFAULT first,
--    convert with USING, then restore the DEFAULT (same pattern used by the
--    production schema reconciliation migration).
ALTER TABLE "esim_purchases" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "esim_purchases" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "esim_purchases" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- 2) esim_top_ups.idempotencyKey: ensure the column exists before the unique
--    index in 20260814000000 references it.
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
