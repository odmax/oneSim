-- Enforce, at the database level, the ledger invariants that wallet-actions.ts
-- guards with check-then-act reads:
--   * exactly ONE WALLET_RESERVE per billing reference (orderId or topUpId)
--   * exactly ONE WALLET_REFUND per billing reference
-- Partial unique indexes (Prisma DSL cannot express WHERE-qualified indexes).
-- CAPTURE/RELEASE intentionally stay multi-row: partial fulfillment writes
-- cumulative delta rows per reference.

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_reserve_one_per_order"
  ON "wallet_transactions"("orderId")
  WHERE "type" = 'WALLET_RESERVE' AND "orderId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_reserve_one_per_topup"
  ON "wallet_transactions"("topUpId")
  WHERE "type" = 'WALLET_RESERVE' AND "topUpId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_refund_one_per_order"
  ON "wallet_transactions"("orderId")
  WHERE "type" = 'WALLET_REFUND' AND "orderId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_refund_one_per_topup"
  ON "wallet_transactions"("topUpId")
  WHERE "type" = 'WALLET_REFUND' AND "topUpId" IS NOT NULL;
