-- Add providerPurchaseKey field for idempotency
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "provider_purchase_key" TEXT;

-- Unique constraint on provider_purchase_key
CREATE UNIQUE INDEX IF NOT EXISTS "esim_purchases_provider_purchase_key_key" ON "esim_purchases"("provider_purchase_key") WHERE "provider_purchase_key" IS NOT NULL;
