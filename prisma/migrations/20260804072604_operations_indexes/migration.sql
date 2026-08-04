-- Operations query indexes
CREATE INDEX IF NOT EXISTS "idx_esim_purchases_status_updated" ON "esim_purchases" ("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "idx_esim_purchases_status_next_retry" ON "esim_purchases" ("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "idx_provider_attempts_order_attempt" ON "provider_attempts" ("orderId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "idx_provider_webhook_events_status_received" ON "provider_webhook_events" ("status", "receivedAt");
CREATE INDEX IF NOT EXISTS "idx_wallet_transactions_order_type" ON "wallet_transactions" ("orderId", "type");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_created" ON "audit_log" ("createdAt");
