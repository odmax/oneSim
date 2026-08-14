-- Billing fix: decouple wallet_transactions.orderId from ESIMPurchase.
-- Top-ups now use the ESIMTopUp id as their own wallet billing identity, so
-- reservation/capture no longer short-circuits on the purchase ledger.
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_orderId_fkey";

-- Immutable quote snapshot captured before provider dispatch (F1/F2).
-- These are the financial source of truth; the provider response never sets the charge.
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedUnitPrice" DECIMAL(65,30);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedTotalAmount" DECIMAL(65,30);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedCurrency" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "quotedQuantity" INTEGER;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "pricingEngineVersion" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "requestedQuantity" INTEGER NOT NULL DEFAULT 1;

-- Idempotency key for top-up retry deduplication (F2).
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "esim_top_ups_idempotencyKey_key" ON "esim_top_ups"("idempotencyKey");

-- Surface failure details without leaking provider raw responses.
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- New lifecycle status for UNCERTAIN/TIMEOUT provider outcomes: funds stay
-- reserved, reconciliation resolves later (prevents double-charge on retry).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'PENDING_REVIEW'
      AND enumtypid = '"ESIMTopUpStatus"'::regtype
  ) THEN
    ALTER TYPE "ESIMTopUpStatus" ADD VALUE 'PENDING_REVIEW';
  END IF;
END $$;
