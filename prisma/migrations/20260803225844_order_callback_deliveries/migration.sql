CREATE TABLE IF NOT EXISTS "order_callback_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventId" TEXT NOT NULL UNIQUE,
  "callbackUrl" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 7,
  "nextAttemptAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastHttpStatus" INTEGER,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "signatureVersion" TEXT DEFAULT 'v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_callback_status" ON "order_callback_deliveries"("status");
CREATE INDEX IF NOT EXISTS "idx_callback_next_attempt" ON "order_callback_deliveries"("nextAttemptAt");
CREATE INDEX IF NOT EXISTS "idx_callback_order" ON "order_callback_deliveries"("orderId");
CREATE INDEX IF NOT EXISTS "idx_callback_business" ON "order_callback_deliveries"("businessId");

DO $$ BEGIN
  ALTER TABLE "order_callback_deliveries" ADD CONSTRAINT "fk_callback_order" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "order_callback_deliveries" ADD CONSTRAINT "fk_callback_business" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
