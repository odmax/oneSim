-- Durable ledger for Custom Package Builder Mode B (UPSTREAM_CREATE).
-- Additive only: creates a new table + indexes. No DROP, no destructive ALTER.
-- Records are written BEFORE any upstream provider mutation so crash/partial
-- failures can be recovered without re-issuing the upstream create call.

-- CreateTable
CREATE TABLE "upstream_package_creation_operations" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "requestedSku" TEXT NOT NULL,
    "requestedByName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "upstreamReference" TEXT,
    "upstreamExternalId" TEXT,
    "providerPackageId" TEXT,
    "esimPackageId" TEXT,
    "requestedBy" TEXT,
    "upstreamStartedAt" TIMESTAMP(3),
    "upstreamCompletedAt" TIMESTAMP(3),
    "localCompletedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessageSafe" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "recoveryState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_package_creation_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique idempotency key — single-writer guarantee)
CREATE UNIQUE INDEX "upstream_package_creation_operations_idempotencyKey_key"
ON "upstream_package_creation_operations"("idempotencyKey");

-- CreateIndex (provider + SKU scan for recovery / already-exists discovery)
CREATE INDEX "upstream_op_provider_sku_idx"
ON "upstream_package_creation_operations"("providerId", "requestedSku");

-- CreateIndex (recovery scan by state)
CREATE INDEX "upstream_package_creation_operations_status_idx"
ON "upstream_package_creation_operations"("status");