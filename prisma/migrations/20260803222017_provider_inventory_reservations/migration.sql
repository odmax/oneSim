-- Create provider_inventory_reservations table for stock safety
CREATE TABLE IF NOT EXISTS "provider_inventory_reservations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "orderId" TEXT,
  "reservationKey" TEXT NOT NULL UNIQUE,
  "requestedQuantity" INTEGER NOT NULL DEFAULT 0,
  "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
  "fulfilledQuantity" INTEGER NOT NULL DEFAULT 0,
  "releasedQuantity" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "providerReservationReference" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "fulfilledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_provider_inventory_reservations_providerId" ON "provider_inventory_reservations"("providerId");
CREATE INDEX IF NOT EXISTS "idx_provider_inventory_reservations_orderId" ON "provider_inventory_reservations"("orderId");
CREATE INDEX IF NOT EXISTS "idx_provider_inventory_reservations_status" ON "provider_inventory_reservations"("status");
CREATE INDEX IF NOT EXISTS "idx_provider_inventory_reservations_expiresAt" ON "provider_inventory_reservations"("expiresAt");
CREATE INDEX IF NOT EXISTS "idx_provider_inventory_reservations_reservationKey" ON "provider_inventory_reservations"("reservationKey");

DO $$ BEGIN
  ALTER TABLE "provider_inventory_reservations" ADD CONSTRAINT "fk_inventory_reservation_provider"
    FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "provider_inventory_reservations" ADD CONSTRAINT "fk_inventory_reservation_order"
    FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
