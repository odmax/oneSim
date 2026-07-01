-- Add missing values to TransactionType enum for wallet operations
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'TOP_UP';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'TOPUP';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'PURCHASE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WALLET_RESERVE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WALLET_CAPTURE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WALLET_RELEASE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WALLET_REFUND';

-- Ensure provider_purchase_key column exists on esim_purchases
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "provider_purchase_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "esim_purchases_provider_purchase_key_key" ON "esim_purchases"("provider_purchase_key") WHERE "provider_purchase_key" IS NOT NULL;
