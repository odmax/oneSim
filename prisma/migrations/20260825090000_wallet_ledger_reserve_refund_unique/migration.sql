-- Enforce, at the database level, the ledger invariants that wallet-actions.ts
-- guards with check-then-act reads:
--   * exactly ONE WALLET_RESERVE per billing reference (orderId or topUpId)
--   * exactly ONE WALLET_REFUND per billing reference
-- Partial unique indexes (Prisma DSL cannot express WHERE-qualified indexes).
-- CAPTURE/RELEASE intentionally stay multi-row: partial fulfillment writes
-- cumulative delta rows per reference.

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_reserve_one_per_order"
  ON "wallet_transactions"("order_id")
  WHERE "type" = 'WALLET_RESERVE' AND "order_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_reserve_one_per_topup"
  ON "wallet_transactions"("top_up_id")
  WHERE "type" = 'WALLET_RESERVE' AND "top_up_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_refund_one_per_order"
  ON "wallet_transactions"("order_id")
  WHERE "type" = 'WALLET_REFUND' AND "order_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_refund_one_per_topup"
  ON "wallet_transactions"("top_up_id")
  WHERE "type" = 'WALLET_REFUND' AND "top_up_id" IS NOT NULL;
