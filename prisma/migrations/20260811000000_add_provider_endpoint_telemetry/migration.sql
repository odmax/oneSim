-- Provider API endpoint telemetry
CREATE TABLE IF NOT EXISTS "provider_endpoint_calls" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "providerId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "endpointPath" TEXT NOT NULL,
    "lastAttemptedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastHttpStatus" INTEGER,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalSuccesses" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_endpoint_calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_endpoint_calls_provider_operation_key" ON "provider_endpoint_calls"("providerId","operation");
