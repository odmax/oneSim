-- AlterTable
-- Additive columns for the atomic outbound callback delivery claim (see
-- src/lib/services/orders/callback-delivery-claim.ts). claimOwner identifies
-- the single worker cleared to POST; claimedUntil makes a crashed/stale claim
-- re-claimable after TTL expiry. NULL claim = unclaimed.
ALTER TABLE "order_callback_deliveries" ADD COLUMN "claimOwner" TEXT;
ALTER TABLE "order_callback_deliveries" ADD COLUMN "claimedUntil" TIMESTAMP(3);