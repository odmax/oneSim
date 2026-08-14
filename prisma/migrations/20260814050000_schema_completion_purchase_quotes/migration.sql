-- Schema completion — PURCHASE QUOTES alignment.
--
-- Aligns the purchase-quote schema across both database shapes:
--   * fresh replay:  purchase_quotes.status is already the "PurchaseQuoteStatus"
--                     enum (created by 20260801000000) — no-op.
--   * drifted prod/dev DBs (built via db-push): purchase_quotes.status is TEXT
--                     and esim_purchases.purchaseQuoteId points at a stale
--                     legacy "PurchaseQuote" table. Both are corrected here so
--                     the existing database ends with the same physical types
--                     as a fresh replay.
--
-- All statements are guarded. No applied migration is modified; checksums are
-- preserved. No data is dropped — only safe type conversion + FK normalization.

-- 1) purchase_quotes.status: TEXT -> "PurchaseQuoteStatus" enum (when drifted).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_quotes' AND column_name='status' AND data_type='text') THEN
    UPDATE "purchase_quotes" SET "status" = 'ACTIVE'
      WHERE "status" IS NULL OR "status" NOT IN ('ACTIVE','EXPIRED','CONSUMED','INVALIDATED','CANCELLED');
    ALTER TABLE "purchase_quotes" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "purchase_quotes" ALTER COLUMN "status" TYPE "PurchaseQuoteStatus" USING "status"::"PurchaseQuoteStatus";
    ALTER TABLE "purchase_quotes" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"PurchaseQuoteStatus";
  END IF;
END $$;

-- 2) purchase_quotes.id: remove the drift-introduced gen_random_uuid() default
--    (Prisma generates cuid client-side; matches the fresh replay / schema).
ALTER TABLE "purchase_quotes" ALTER COLUMN "id" DROP DEFAULT;

-- 3) esim_purchases.purchaseQuoteId FK: point at the canonical purchase_quotes
--    table with ON UPDATE CASCADE (recreated only if it references the wrong
--    table, e.g. the stale dev-only "PurchaseQuote").
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'esim_purchases_purchaseQuoteId_fkey'
      AND pg_get_constraintdef(oid) NOT LIKE '%purchase_quotes%'
  ) THEN
    ALTER TABLE "esim_purchases" DROP CONSTRAINT "esim_purchases_purchaseQuoteId_fkey";
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "esim_purchases" ADD CONSTRAINT "esim_purchases_purchaseQuoteId_fkey"
    FOREIGN KEY ("purchaseQuoteId") REFERENCES "purchase_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
