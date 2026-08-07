-- Add travel-date persistence to orders for retry stability
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "requestedTravelDate" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "resolvedTravelDate" TEXT;
