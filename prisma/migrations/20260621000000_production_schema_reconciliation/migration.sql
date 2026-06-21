-- =============================================================================
-- Production Schema Reconciliation
-- Adds all columns, tables, indexes, and enums that were added to schema.prisma
-- but never created by any migration in the chain.
-- Safe to run on any DB — uses IF NOT EXISTS and DO blocks throughout.
-- =============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PackageSource" AS ENUM ('PROVIDER_PLAN', 'CATALOG_PRODUCT', 'MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ProviderType" AS ENUM ('IBASIS', 'CHOICE', 'MOCK', 'CUSTOM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'MAINTENANCE', 'INACTIVE', 'TESTING', 'ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TopUpRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PaymentMethod" AS ENUM ('MANUAL', 'GATEWAY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'INACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "JobType" AS ENUM ('ACTIVATION_SYNC', 'WEBHOOK_DELIVERY', 'USAGE_SYNC', 'EMAIL_DELIVERY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── InternalAdminRole enum values ─────────────────────────────────────────────
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'OPERATIONS_MANAGER';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'PRODUCT_MANAGER';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'SUPPORT_MANAGER';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'SUPPORT_AGENT';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'ANALYTICS_MANAGER';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'FINANCE_MANAGER';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'READ_ONLY';

-- ── Missing columns on existing tables ───────────────────────────────────────
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "action" TEXT NOT NULL DEFAULT '';
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "rateLimitPerMinute" INTEGER;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "costPriceUSD" DECIMAL(65,30);
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "customerDescription" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "markupPercent" DECIMAL(65,30);
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "packageCode" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerMapping" JSONB;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerName" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerPlanId" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "providerRawData" JSONB;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "sku" TEXT;
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "source" "PackageSource" NOT NULL DEFAULT 'CATALOG_PRODUCT';
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "callbackUrl" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerResponse" JSONB;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "providerStatus" TEXT;
ALTER TABLE "esim_purchases" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "activationCode" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT NOT NULL DEFAULT 'NOT_SENT';
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "imsi" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "providerActivationId" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "providerResponse" JSONB;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "providerStatus" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "providerSubscriptionId" TEXT;
ALTER TABLE "esims" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT '';

-- ── Fix column types ─────────────────────────────────────────────────────────
ALTER TABLE "provider_packages" ALTER COLUMN "adminCostPrice" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "provider_packages" ALTER COLUMN "effectiveCostPrice" SET DATA TYPE DECIMAL(65,30);

-- Convert TEXT to enum types where schema expects enums
-- (data must already contain valid enum values)
ALTER TABLE "customers" ALTER COLUMN "status" TYPE "CustomerStatus" USING "status"::"CustomerStatus";
ALTER TABLE "providers" ALTER COLUMN "type" TYPE "ProviderType" USING "type"::"ProviderType";
ALTER TABLE "providers" ALTER COLUMN "status" TYPE "ProviderStatus" USING "status"::"ProviderStatus";

-- ── New tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SET_PASSWORD', "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wallet_top_up_requests" (
    "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "requestedById" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL, "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "TopUpRequestStatus" NOT NULL DEFAULT 'PENDING',
    "paymentReference" TEXT NOT NULL, "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'MANUAL',
    "gatewayProvider" TEXT, "gatewayReference" TEXT, "proofUrl" TEXT, "adminNote" TEXT,
    "approvedById" TEXT, "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_top_up_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "annual_markup_settings" (
    "id" TEXT NOT NULL, "year" INTEGER NOT NULL, "markupPercent" DECIMAL(65,30) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true, "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "annual_markup_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_rules" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
    "ruleType" TEXT NOT NULL DEFAULT 'GLOBAL_DISCOUNT',
    "ruleMode" TEXT NOT NULL DEFAULT 'PERCENTAGE', "value" DECIMAL(65,30),
    "priority" INTEGER NOT NULL DEFAULT 0, "isActive" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT, "region" TEXT, "country" TEXT, "packageId" TEXT, "packageType" TEXT,
    "startDate" TIMESTAMP(3), "endDate" TIMESTAMP(3), "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "business_api_keys" (
    "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL, "keyPrefix" TEXT NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE', "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "business_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "idempotency_records" (
    "id" TEXT NOT NULL, "key" TEXT NOT NULL, "businessId" TEXT NOT NULL,
    "response" JSONB NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "business_webhook_endpoints" (
    "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "name" TEXT NOT NULL,
    "url" TEXT NOT NULL, "secret" TEXT NOT NULL,
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "events" JSONB NOT NULL, "lastSuccessAt" TIMESTAMP(3), "lastFailureAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "business_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL, "eventId" TEXT, "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "responseCode" INTEGER, "responseBody" TEXT, "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0, "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sentAt" TIMESTAMP(3),
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "background_jobs" (
    "id" TEXT NOT NULL, "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING', "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0, "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "api_request_logs" (
    "id" TEXT NOT NULL, "businessId" TEXT NOT NULL, "apiKeyId" TEXT,
    "method" TEXT NOT NULL, "path" TEXT NOT NULL, "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL, "ipAddress" TEXT, "userAgent" TEXT,
    "idempotencyKey" TEXT, "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "provider_configs" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
    "base_url" TEXT NOT NULL, "auth_type" TEXT NOT NULL,
    "credentials" TEXT NOT NULL, "adapter_class" TEXT NOT NULL DEFAULT 'rest_generic',
    "field_mappings" JSONB NOT NULL DEFAULT '{}', "endpoints" JSONB NOT NULL DEFAULT '{}',
    "webhook_config" JSONB NOT NULL DEFAULT '{}', "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "provider_templates" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
    "connectorType" TEXT NOT NULL DEFAULT 'STANDARD',
    "authType" TEXT NOT NULL DEFAULT 'bearer_token',
    "tokenPlacement" TEXT NOT NULL DEFAULT 'URL_PATH',
    "defaultBaseUrl" TEXT, "defaultAuthUrl" TEXT,
    "defaultPlanListPath" TEXT, "defaultActivationPath" TEXT,
    "defaultStatusPath" TEXT, "defaultUsagePath" TEXT,
    "defaultSuspendPath" TEXT, "defaultResumePath" TEXT,
    "defaultTopUpPath" TEXT, "defaultResponseListKey" TEXT,
    "defaultFieldMappings" JSONB NOT NULL DEFAULT '{}',
    "defaultCapabilities" JSONB NOT NULL DEFAULT '{}',
    "endpointMappings" JSONB, "requestMappings" JSONB, "responseMappings" JSONB,
    "requiredConfigFields" JSONB, "optionalConfigFields" JSONB,
    "isSystemTemplate" BOOLEAN NOT NULL DEFAULT false, "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_templates_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "password_reset_tokens_userId_type_idx" ON "password_reset_tokens"("userId", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_top_up_requests_paymentReference_key" ON "wallet_top_up_requests"("paymentReference");
CREATE UNIQUE INDEX IF NOT EXISTS "annual_markup_settings_year_key" ON "annual_markup_settings"("year");
CREATE UNIQUE INDEX IF NOT EXISTS "business_api_keys_keyPrefix_key" ON "business_api_keys"("keyPrefix");
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_key_key" ON "idempotency_records"("key");
CREATE INDEX IF NOT EXISTS "business_webhook_endpoints_businessId_idx" ON "business_webhook_endpoints"("businessId");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_businessId_createdAt_idx" ON "webhook_deliveries"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpointId_idx" ON "webhook_deliveries"("endpointId");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_idx" ON "webhook_deliveries"("status");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_eventType_idx" ON "webhook_deliveries"("eventType");
CREATE INDEX IF NOT EXISTS "background_jobs_status_runAt_idx" ON "background_jobs"("status", "runAt");
CREATE INDEX IF NOT EXISTS "api_request_logs_businessId_createdAt_idx" ON "api_request_logs"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "api_request_logs_apiKeyId_idx" ON "api_request_logs"("apiKeyId");
CREATE INDEX IF NOT EXISTS "api_request_logs_path_idx" ON "api_request_logs"("path");
CREATE INDEX IF NOT EXISTS "api_request_logs_statusCode_idx" ON "api_request_logs"("statusCode");
CREATE INDEX IF NOT EXISTS "api_request_logs_createdAt_idx" ON "api_request_logs"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "provider_configs_slug_key" ON "provider_configs"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "esim_packages_sku_key" ON "esim_packages"("sku");
CREATE UNIQUE INDEX IF NOT EXISTS "esim_packages_packageCode_key" ON "esim_packages"("packageCode");
CREATE UNIQUE INDEX IF NOT EXISTS "esim_packages_providerPackageId_key" ON "esim_packages"("providerPackageId");

-- ── Foreign Keys (safe DO blocks) ────────────────────────────────────────────
DO $$ BEGIN ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "esim_packages" ADD CONSTRAINT "esim_packages_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "esim_packages" ADD CONSTRAINT "esim_packages_providerPackageId_fkey" FOREIGN KEY ("providerPackageId") REFERENCES "provider_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "esims" ADD CONSTRAINT "esims_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "wallet_top_up_requests" ADD CONSTRAINT "wallet_top_up_requests_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "wallet_top_up_requests" ADD CONSTRAINT "wallet_top_up_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "wallet_top_up_requests" ADD CONSTRAINT "wallet_top_up_requests_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "esim_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "business_api_keys" ADD CONSTRAINT "business_api_keys_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "business_webhook_endpoints" ADD CONSTRAINT "business_webhook_endpoints_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "business_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
