-- Add costCurrency field to esim_packages for wholesale pricing
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "costCurrency" TEXT DEFAULT 'USD';
