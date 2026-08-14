-- Billing fix (Option A): top-ups get their own wallet billing identity via
-- wallet_transactions.topUpId (FK -> esim_top_ups.id). The purchase FK
-- wallet_transactions.orderId is KEPT — purchases keep the orderId ledger, top-ups
-- key their reserve/capture/release entries by topUpId. The two references are
-- mutually exclusive and never both populated.

-- 1. Preserve purchase referential integrity. On databases where a prior build
--    dropped the purchase FK (never shipped — guard makes this a no-op there),
--    restore it so orderId always references a real esim_purchases row.
DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- 2. Add the top-up billing reference with its own FK and index.
--    Indexes are composite (reference, type) to match every wallet read pattern
--    (where: { orderId|topUpId, type }). The legacy orderId index is replaced by
--    the Prisma-named equivalent so the schema and database never drift.
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "topUpId" TEXT;
DO $$ BEGIN
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_topUpId_fkey"
    FOREIGN KEY ("topUpId") REFERENCES "esim_top_ups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DROP INDEX IF EXISTS "wallet_transactions_topUpId_idx";
DROP INDEX IF EXISTS "idx_wallet_transactions_order_type";
CREATE INDEX IF NOT EXISTS "wallet_transactions_orderId_type_idx" ON "wallet_transactions"("orderId", "type");
CREATE INDEX IF NOT EXISTS "wallet_transactions_topUpId_type_idx" ON "wallet_transactions"("topUpId", "type");

-- 3. Immutable quote snapshot captured before provider dispatch (F1/F2).
--    These are the financial source of truth; the provider response never sets the charge.
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedUnitPrice" DECIMAL(65,30);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedTotalAmount" DECIMAL(65,30);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedCurrency" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedQuantity" INTEGER;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "pricingEngineVersion" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "requestedQuantity" INTEGER NOT NULL DEFAULT 1;

-- 4. Idempotency key scoped per business (F2): a key supplied by one Business must
--    not collide with another Business using the same client-generated key.
--    Drop the legacy global-unique index if a prior build created it (never shipped).
DROP INDEX IF EXISTS "esim_top_ups_idempotencyKey_key";
CREATE UNIQUE INDEX IF NOT EXISTS "esim_top_ups_businessId_idempotencyKey_key"
  ON "esim_top_ups"("businessId", "idempotencyKey");

-- 5. Surface failure details without leaking provider raw responses.
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- 6. New lifecycle status for UNCERTAIN/TIMEOUT provider outcomes: funds stay
--    reserved, reconciliation resolves later (prevents double-charge on retry).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'PENDING_REVIEW'
      AND enumtypid = '"ESIMTopUpStatus"'::regtype
  ) THEN
    ALTER TYPE "ESIMTopUpStatus" ADD VALUE 'PENDING_REVIEW';
  END IF;
END $$;
