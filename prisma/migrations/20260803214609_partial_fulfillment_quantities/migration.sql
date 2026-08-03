-- Add partial-fulfillment quantity accounting fields to esim_purchases
-- All new columns have safe defaults for legacy orders
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "fulfilledQuantity" INTEGER DEFAULT 0;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "failedQuantity" INTEGER DEFAULT 0;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "fulfillmentCompletedAt" TIMESTAMP(3);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "capturedAmount" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "releasedAmount" DECIMAL(65,30);
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "refundedAmount" DECIMAL(65,30);

-- Backfill: set fulfilledQuantity for existing FULFILLED orders
UPDATE "esim_purchases"
SET "fulfilledQuantity" = COALESCE("quotedQuantity", "quantity", 0)
WHERE "status" = 'FULFILLED' AND "fulfilledQuantity" = 0;
