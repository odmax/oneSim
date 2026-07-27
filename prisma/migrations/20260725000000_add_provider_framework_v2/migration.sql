-- Provider Framework V2 — Additive Schema Migration
-- This migration ONLY adds new V2 objects. No existing tables are modified
-- except the providers table which receives new nullable columns.

-- ============================================================================
-- 1. NEW ENUMS (27 enums)
-- ============================================================================

CREATE TYPE "PV2TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DEPRECATED', 'ARCHIVED');
CREATE TYPE "PV2TemplateProtocol" AS ENUM ('REST', 'SOAP', 'GRAPHQL', 'CUSTOM');
CREATE TYPE "PV2AuthStrategy" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN', 'STATIC_TOKEN', 'BASIC', 'OAUTH1', 'OAUTH2', 'HMAC', 'SOAP_WS_SECURITY', 'CUSTOM');
CREATE TYPE "PV2HttpMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS');
CREATE TYPE "PV2ContentType" AS ENUM ('APPLICATION_JSON', 'APPLICATION_XML', 'APPLICATION_FORM_URLENCODED', 'TEXT_PLAIN', 'TEXT_XML', 'MULTIPART_FORM_DATA', 'OCTET_STREAM');
CREATE TYPE "PV2ParamSourceType" AS ENUM ('STATIC', 'CREDENTIAL', 'INPUT', 'CONTEXT', 'PREVIOUS_STEP', 'ENVIRONMENT', 'COMPUTED');
CREATE TYPE "PV2FieldDataType" AS ENUM ('STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'UUID', 'JSON', 'ARRAY', 'OBJECT');
CREATE TYPE "PV2MappingFailureBehavior" AS ENUM ('FAIL', 'WARN', 'SKIP', 'USE_DEFAULT');
CREATE TYPE "PV2MappingAssociation" AS ENUM ('REQUEST', 'RESPONSE', 'WEBHOOK', 'ERROR', 'PAGINATION');
CREATE TYPE "PV2TransformationType" AS ENUM ('TRIM', 'LOWERCASE', 'UPPERCASE', 'NUMBER', 'BOOLEAN', 'DATE_FORMAT', 'ENUM_MAP', 'UNIT_CONVERSION', 'CURRENCY_CONVERSION', 'CONCAT', 'SPLIT', 'PREFIX', 'SUFFIX', 'REGEX_REPLACE', 'JSON_PARSE', 'JSON_STRINGIFY', 'CUSTOM');
CREATE TYPE "PV2ErrorCategory" AS ENUM ('AUTHENTICATION_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'INSUFFICIENT_BALANCE', 'DUPLICATE_REQUEST', 'TEMPORARY_FAILURE', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'CONFLICT', 'UNKNOWN');
CREATE TYPE "PV2ErrorSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');
CREATE TYPE "PV2BackoffStrategy" AS ENUM ('FIXED', 'LINEAR', 'EXPONENTIAL');
CREATE TYPE "PV2CacheScope" AS ENUM ('GLOBAL', 'PROVIDER', 'BUSINESS', 'CUSTOMER', 'REQUEST');
CREATE TYPE "PV2PaginationStrategy" AS ENUM ('NONE', 'PAGE_NUMBER', 'OFFSET_LIMIT', 'CURSOR', 'NEXT_URL', 'LINK_HEADER', 'CUSTOM');
CREATE TYPE "PV2WebhookSignatureStrategy" AS ENUM ('NONE', 'HMAC_SHA256', 'HMAC_SHA512', 'RSA', 'SIMPLE');
CREATE TYPE "PV2NormalizedWebhookEvent" AS ENUM ('SUBSCRIPTION_STATUS_CHANGED', 'SUBSCRIPTION_ACTIVATED', 'ESIM_STATUS_CHANGED', 'ORDER_STATUS_CHANGED', 'USAGE_UPDATED', 'THRESHOLD_REACHED', 'BALANCE_UPDATED', 'PLAN_CHANGED', 'PORTABILITY_STATUS_CHANGED', 'CUSTOM');
CREATE TYPE "PV2SyncType" AS ENUM ('CATALOG', 'PRICING', 'INVENTORY', 'STATUS', 'USAGE', 'BALANCE');
CREATE TYPE "PV2SyncConflictStrategy" AS ENUM ('PROVIDER_WINS', 'LOCAL_WINS', 'LATEST_WINS', 'MANUAL');
CREATE TYPE "PV2SyncDeletionStrategy" AS ENUM ('IGNORE', 'SOFT_DELETE', 'DEACTIVATE');
CREATE TYPE "PV2PipelineStage" AS ENUM ('AUTHENTICATE', 'PRE_REQUEST', 'BUILD_REQUEST', 'SIGN_REQUEST', 'EXECUTE', 'VALIDATE_RESPONSE', 'MAP_RESPONSE', 'TRANSFORM', 'NORMALIZE', 'POST_PROCESS', 'EMIT_EVENTS');
CREATE TYPE "PV2PipelineFailureBehavior" AS ENUM ('FAIL', 'SKIP', 'ABORT');
CREATE TYPE "PV2EventType" AS ENUM ('PROVIDER_REQUEST_STARTED', 'PROVIDER_REQUEST_SUCCEEDED', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_HEALTH_CHANGED', 'SYNC_STARTED', 'SYNC_COMPLETED', 'SYNC_FAILED', 'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED', 'ESIM_ALLOCATED', 'SUBSCRIPTION_CHANGED', 'USAGE_UPDATED', 'BALANCE_UPDATED', 'WEBHOOK_RECEIVED');
CREATE TYPE "PV2EventStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
CREATE TYPE "PV2ValidationSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');
CREATE TYPE "PV2ValidationPhase" AS ENUM ('DRAFT', 'PUBLISH', 'INSTALL', 'UPGRADE', 'RUNTIME');
CREATE TYPE "PV2RequestBodyMode" AS ENUM ('NONE', 'JSON', 'FORM_DATA', 'RAW', 'STREAM');
CREATE TYPE "PV2ResponseBodyMode" AS ENUM ('JSON', 'XML', 'STREAM', 'TEXT');
CREATE TYPE "PV2FeaturePackStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'ARCHIVED');

-- ============================================================================
-- 2. ALTER PROVIDERS TABLE — Add nullable V2 linkage columns
-- ============================================================================

ALTER TABLE "providers" ADD COLUMN "pv2TemplateId" TEXT;
ALTER TABLE "providers" ADD COLUMN "pv2TemplateVersionId" TEXT;
ALTER TABLE "providers" ADD COLUMN "pv2ConfigStatus" TEXT;
ALTER TABLE "providers" ADD COLUMN "pv2MigrationStatus" TEXT;
ALTER TABLE "providers" ADD COLUMN "pv2LastValidationResult" JSONB;
ALTER TABLE "providers" ADD COLUMN "pv2LastTemplateUpgradeAt" TIMESTAMP(3);
ALTER TABLE "providers" ADD COLUMN "pv2EnabledFeaturePacks" JSONB;

-- ============================================================================
-- 3. CORE MODELS — Operations, Feature Packs, Templates
-- ============================================================================

-- Operation Registry
CREATE TABLE "pv2_operations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_operations_pkey" PRIMARY KEY ("id")
);

-- Feature Packs
CREATE TABLE "pv2_feature_packs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "PV2FeaturePackStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_feature_packs_pkey" PRIMARY KEY ("id")
);

-- Feature Pack ↔ Operation junction
CREATE TABLE "pv2_feature_pack_operations" (
    "id" TEXT NOT NULL,
    "featurePackId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_feature_pack_operations_pkey" PRIMARY KEY ("id")
);

-- V2 Templates (versioned)
CREATE TABLE "pv2_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "providerFamily" TEXT NOT NULL,
    "providerCategory" TEXT,
    "semanticVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PV2TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystemTemplate" BOOLEAN NOT NULL DEFAULT false,
    "minimumFrameworkVersion" TEXT,
    "parentTemplateId" TEXT,
    "parentTemplateVersion" TEXT,
    "upgradeMetadata" JSONB,
    "protocolType" "PV2TemplateProtocol" NOT NULL DEFAULT 'REST',
    "baseUrl" TEXT,
    "baseUrlDev" TEXT,
    "baseUrlStaging" TEXT,
    "changelog" TEXT,
    "createdBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_templates_pkey" PRIMARY KEY ("id")
);

-- Template Versions (immutable snapshots)
CREATE TABLE "pv2_template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "semanticVersion" TEXT NOT NULL,
    "status" "PV2TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "changelog" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_versions_pkey" PRIMARY KEY ("id")
);

-- Template ↔ Feature Pack junction
CREATE TABLE "pv2_template_feature_packs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "featurePackId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_feature_packs_pkey" PRIMARY KEY ("id")
);

-- Provider ↔ Feature Pack overrides
CREATE TABLE "pv2_provider_feature_pack_overrides" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "featurePackId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overrideConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_provider_feature_pack_overrides_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 4. AUTHENTICATION CONFIGURATION
-- ============================================================================

CREATE TABLE "pv2_template_auth_configs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "strategy" "PV2AuthStrategy" NOT NULL DEFAULT 'NONE',
    "customStrategyKey" TEXT,
    "authEndpoint" TEXT,
    "authMethod" TEXT NOT NULL DEFAULT 'POST',
    "contentType" "PV2ContentType" NOT NULL DEFAULT 'APPLICATION_JSON',
    "headerName" TEXT,
    "queryParamName" TEXT,
    "bodyFieldName" TEXT,
    "tokenPrefix" TEXT,
    "tokenPath" TEXT,
    "tokenExpiryPath" TEXT,
    "refreshTokenPath" TEXT,
    "secretFields" JSONB,
    "optionalFields" JSONB,
    "credentialDefs" JSONB,
    "validationRules" JSONB,
    "refreshConfig" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_auth_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_auth_request_mappings" (
    "id" TEXT NOT NULL,
    "authConfigId" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "sourceType" "PV2ParamSourceType" NOT NULL DEFAULT 'INPUT',
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "transformId" TEXT,
    "validationId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_auth_request_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_auth_response_mappings" (
    "id" TEXT NOT NULL,
    "authConfigId" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "transformId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_auth_response_mappings_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 5. ENDPOINT DEFINITIONS
-- ============================================================================

CREATE TABLE "pv2_template_endpoints" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "operationId" TEXT NOT NULL,
    "endpointKey" TEXT NOT NULL,
    "displayName" TEXT,
    "httpMethod" "PV2HttpMethod" NOT NULL DEFAULT 'GET',
    "relativePath" TEXT NOT NULL,
    "absoluteUrl" TEXT,
    "protocolType" "PV2TemplateProtocol" NOT NULL DEFAULT 'REST',
    "contentType" "PV2ContentType" NOT NULL DEFAULT 'APPLICATION_JSON',
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "authRequired" BOOLEAN NOT NULL DEFAULT true,
    "paginationStrategy" "PV2PaginationStrategy" NOT NULL DEFAULT 'NONE',
    "idempotencyKey" TEXT,
    "idempotencyHeader" TEXT,
    "requestBodyMode" "PV2RequestBodyMode" NOT NULL DEFAULT 'JSON',
    "responseBodyMode" "PV2ResponseBodyMode" NOT NULL DEFAULT 'JSON',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "executionOrder" INTEGER NOT NULL DEFAULT 0,
    "cachePolicyId" TEXT,
    "retryPolicyId" TEXT,
    "healthRelevant" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_endpoint_headers" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "sourceType" "PV2ParamSourceType" NOT NULL DEFAULT 'STATIC',
    "sourcePath" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "defaultValue" TEXT,
    "transformId" TEXT,
    "validationId" TEXT,
    "condition" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_endpoint_headers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_endpoint_query_params" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "sourceType" "PV2ParamSourceType" NOT NULL DEFAULT 'STATIC',
    "sourcePath" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "defaultValue" TEXT,
    "transformId" TEXT,
    "validationId" TEXT,
    "condition" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_endpoint_query_params_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_endpoint_path_params" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "sourceType" "PV2ParamSourceType" NOT NULL DEFAULT 'INPUT',
    "sourcePath" TEXT,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "transformId" TEXT,
    "validationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_endpoint_path_params_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_endpoint_body_params" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "sourceType" "PV2ParamSourceType" NOT NULL DEFAULT 'INPUT',
    "sourcePath" TEXT,
    "destinationPath" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "defaultValue" TEXT,
    "transformId" TEXT,
    "validationId" TEXT,
    "condition" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_template_endpoint_body_params_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 6. FIELD MAPPINGS, TRANSFORMATIONS, ERROR MAPPINGS
-- ============================================================================

CREATE TABLE "pv2_template_field_mappings" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "endpointId" TEXT,
    "association" "PV2MappingAssociation" NOT NULL DEFAULT 'REQUEST',
    "operationCode" TEXT,
    "sourcePath" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "dataType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "isNullable" BOOLEAN NOT NULL DEFAULT true,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "transformId" TEXT,
    "validationId" TEXT,
    "arrayMapping" JSONB,
    "nestedObjectMapping" JSONB,
    "enumMapping" JSONB,
    "fallbackPaths" JSONB,
    "omissionRule" TEXT,
    "failureBehavior" "PV2MappingFailureBehavior" NOT NULL DEFAULT 'FAIL',
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_field_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_transformations" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "code" TEXT NOT NULL,
    "type" "PV2TransformationType" NOT NULL DEFAULT 'TRIM',
    "config" JSONB,
    "inputType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "outputType" "PV2FieldDataType" NOT NULL DEFAULT 'STRING',
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "executionOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_transformations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_error_mappings" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "httpStatus" INTEGER,
    "providerErrorCode" TEXT,
    "providerMessage" TEXT,
    "providerMessageRegex" TEXT,
    "jsonPath" TEXT,
    "operationCode" TEXT,
    "endpointKey" TEXT,
    "normalizedCode" "PV2ErrorCategory" NOT NULL DEFAULT 'UNKNOWN',
    "normalizedMessage" TEXT,
    "internalErrorCode" TEXT,
    "severity" "PV2ErrorSeverity" NOT NULL DEFAULT 'ERROR',
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "userSafeMessage" TEXT,
    "loggingLevel" TEXT NOT NULL DEFAULT 'ERROR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_error_mappings_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 7. RETRY, RATE LIMIT, CACHE POLICIES
-- ============================================================================

CREATE TABLE "pv2_template_retry_policies" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "initialDelayMs" INTEGER NOT NULL DEFAULT 1000,
    "maxDelayMs" INTEGER NOT NULL DEFAULT 30000,
    "backoffStrategy" "PV2BackoffStrategy" NOT NULL DEFAULT 'EXPONENTIAL',
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "jitter" BOOLEAN NOT NULL DEFAULT true,
    "retryableStatuses" JSONB,
    "retryableErrorTypes" JSONB,
    "idempotentOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_retry_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_rate_limit_policies" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "requestsPerSecond" INTEGER NOT NULL DEFAULT 10,
    "requestsPerMinute" INTEGER NOT NULL DEFAULT 600,
    "requestsPerHour" INTEGER NOT NULL DEFAULT 36000,
    "concurrentLimit" INTEGER NOT NULL DEFAULT 10,
    "burstLimit" INTEGER NOT NULL DEFAULT 20,
    "providerHeaderMappings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_rate_limit_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_cache_policies" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ttlMs" INTEGER NOT NULL DEFAULT 300000,
    "staleWhileRevalidate" BOOLEAN NOT NULL DEFAULT false,
    "staleTtlMs" INTEGER,
    "cacheKeyFields" JSONB,
    "invalidateOnOps" JSONB,
    "scope" "PV2CacheScope" NOT NULL DEFAULT 'REQUEST',
    "sensitiveDataExclusion" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_cache_policies_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 8. PAGINATION, WEBHOOKS, HEALTH CHECKS, SYNC
-- ============================================================================

CREATE TABLE "pv2_template_pagination_configs" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "strategy" "PV2PaginationStrategy" NOT NULL DEFAULT 'NONE',
    "pageParam" TEXT,
    "pageSizeParam" TEXT,
    "offsetParam" TEXT,
    "limitParam" TEXT,
    "cursorParam" TEXT,
    "nextCursorPath" TEXT,
    "nextUrlPath" TEXT,
    "resultsPath" TEXT,
    "totalCountPath" TEXT,
    "maxPages" INTEGER NOT NULL DEFAULT 100,
    "defaultPageSize" INTEGER NOT NULL DEFAULT 50,
    "stopConditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_pagination_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_webhook_configs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "eventCode" TEXT NOT NULL,
    "normalizedEvent" "PV2NormalizedWebhookEvent" NOT NULL DEFAULT 'CUSTOM',
    "httpMethod" TEXT NOT NULL DEFAULT 'POST',
    "signatureStrategy" "PV2WebhookSignatureStrategy" NOT NULL DEFAULT 'NONE',
    "signatureHeader" TEXT,
    "secretCredentialKey" TEXT,
    "payloadMappings" JSONB,
    "acknowledgementCode" INTEGER NOT NULL DEFAULT 200,
    "acknowledgementBody" JSONB,
    "replayProtection" BOOLEAN NOT NULL DEFAULT false,
    "timestampPath" TEXT,
    "eventIdPath" TEXT,
    "deduplicationStrategy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_webhook_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_health_checks" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "operationId" TEXT NOT NULL,
    "endpointKey" TEXT NOT NULL,
    "expectedStatuses" JSONB,
    "expectedResponseMapping" JSONB,
    "intervalMs" INTEGER NOT NULL DEFAULT 60000,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "recoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_health_checks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_sync_configs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "syncType" "PV2SyncType" NOT NULL,
    "operationId" TEXT NOT NULL,
    "scheduleCron" TEXT,
    "scheduleIntervalMs" INTEGER,
    "paginationConfig" JSONB,
    "incrementalCursor" TEXT,
    "cursorStorageKey" TEXT,
    "batchSize" INTEGER NOT NULL DEFAULT 50,
    "conflictStrategy" "PV2SyncConflictStrategy" NOT NULL DEFAULT 'PROVIDER_WINS',
    "deletionStrategy" "PV2SyncDeletionStrategy" NOT NULL DEFAULT 'IGNORE',
    "emitEvents" BOOLEAN NOT NULL DEFAULT false,
    "eventTypes" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_sync_configs_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 9. PIPELINE, EVENTS, VALIDATION
-- ============================================================================

CREATE TABLE "pv2_template_pipeline_configs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "stage" "PV2PipelineStage" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "executionOrder" INTEGER NOT NULL DEFAULT 0,
    "adapterKey" TEXT,
    "stageConfig" JSONB,
    "failureBehavior" "PV2PipelineFailureBehavior" NOT NULL DEFAULT 'FAIL',
    "condition" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_pipeline_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_events" (
    "id" TEXT NOT NULL,
    "eventType" "PV2EventType" NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "providerId" TEXT,
    "businessId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "PV2EventStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pv2_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pv2_template_validation_rules" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "operationId" TEXT,
    "ruleCode" TEXT NOT NULL,
    "description" TEXT,
    "severity" "PV2ValidationSeverity" NOT NULL DEFAULT 'ERROR',
    "phase" "PV2ValidationPhase" NOT NULL DEFAULT 'DRAFT',
    "category" TEXT NOT NULL,
    "ruleConfig" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pv2_template_validation_rules_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 10. INDEXES
-- ============================================================================

-- Provider V2 linkage indexes
CREATE INDEX "providers_pv2TemplateId_idx" ON "providers"("pv2TemplateId");
CREATE INDEX "providers_pv2TemplateVersionId_idx" ON "providers"("pv2TemplateVersionId");

-- Operation indexes
CREATE UNIQUE INDEX "pv2_operations_code_key" ON "pv2_operations"("code");
CREATE INDEX "pv2_operations_category_idx" ON "pv2_operations"("category");
CREATE INDEX "pv2_operations_isActive_idx" ON "pv2_operations"("isActive");

-- Feature Pack indexes
CREATE UNIQUE INDEX "pv2_feature_packs_code_key" ON "pv2_feature_packs"("code");
CREATE UNIQUE INDEX "pv2_feature_pack_operations_featurePackId_operationId_key" ON "pv2_feature_pack_operations"("featurePackId", "operationId");

-- Template indexes
CREATE UNIQUE INDEX "pv2_templates_code_semanticVersion_key" ON "pv2_templates"("code", "semanticVersion");
CREATE INDEX "pv2_templates_code_idx" ON "pv2_templates"("code");
CREATE INDEX "pv2_templates_providerFamily_idx" ON "pv2_templates"("providerFamily");
CREATE INDEX "pv2_templates_status_idx" ON "pv2_templates"("status");
CREATE INDEX "pv2_templates_isActive_idx" ON "pv2_templates"("isActive");

-- Template Version indexes
CREATE UNIQUE INDEX "pv2_template_versions_templateId_version_key" ON "pv2_template_versions"("templateId", "version");
CREATE UNIQUE INDEX "pv2_template_versions_templateId_semanticVersion_key" ON "pv2_template_versions"("templateId", "semanticVersion");
CREATE INDEX "pv2_template_versions_templateId_idx" ON "pv2_template_versions"("templateId");
CREATE INDEX "pv2_template_versions_status_idx" ON "pv2_template_versions"("status");

-- Template Feature Pack indexes
CREATE UNIQUE INDEX "pv2_template_feature_packs_templateId_featurePackId_key" ON "pv2_template_feature_packs"("templateId", "featurePackId");

-- Provider Feature Pack Override indexes
CREATE UNIQUE INDEX "pv2_provider_feature_pack_overrides_providerId_featurePackI_key" ON "pv2_provider_feature_pack_overrides"("providerId", "featurePackId");

-- Auth Config indexes
CREATE UNIQUE INDEX "pv2_template_auth_configs_templateId_key" ON "pv2_template_auth_configs"("templateId");
CREATE INDEX "pv2_template_auth_request_mappings_authConfigId_idx" ON "pv2_template_auth_request_mappings"("authConfigId");
CREATE INDEX "pv2_template_auth_response_mappings_authConfigId_idx" ON "pv2_template_auth_response_mappings"("authConfigId");

-- Endpoint indexes
CREATE UNIQUE INDEX "pv2_template_endpoints_templateId_endpointKey_key" ON "pv2_template_endpoints"("templateId", "endpointKey");
CREATE UNIQUE INDEX "pv2_template_endpoints_templateVersionId_endpointKey_key" ON "pv2_template_endpoints"("templateVersionId", "endpointKey");
CREATE INDEX "pv2_template_endpoints_templateId_idx" ON "pv2_template_endpoints"("templateId");
CREATE INDEX "pv2_template_endpoints_templateVersionId_idx" ON "pv2_template_endpoints"("templateVersionId");
CREATE INDEX "pv2_template_endpoints_operationId_idx" ON "pv2_template_endpoints"("operationId");
CREATE INDEX "pv2_template_endpoints_isActive_idx" ON "pv2_template_endpoints"("isActive");

-- Endpoint param indexes
CREATE INDEX "pv2_template_endpoint_headers_endpointId_idx" ON "pv2_template_endpoint_headers"("endpointId");
CREATE INDEX "pv2_template_endpoint_query_params_endpointId_idx" ON "pv2_template_endpoint_query_params"("endpointId");
CREATE INDEX "pv2_template_endpoint_path_params_endpointId_idx" ON "pv2_template_endpoint_path_params"("endpointId");
CREATE INDEX "pv2_template_endpoint_body_params_endpointId_idx" ON "pv2_template_endpoint_body_params"("endpointId");

-- Field Mapping indexes
CREATE INDEX "pv2_template_field_mappings_templateId_idx" ON "pv2_template_field_mappings"("templateId");
CREATE INDEX "pv2_template_field_mappings_templateVersionId_idx" ON "pv2_template_field_mappings"("templateVersionId");
CREATE INDEX "pv2_template_field_mappings_endpointId_idx" ON "pv2_template_field_mappings"("endpointId");
CREATE INDEX "pv2_template_field_mappings_association_idx" ON "pv2_template_field_mappings"("association");
CREATE INDEX "pv2_template_field_mappings_operationCode_idx" ON "pv2_template_field_mappings"("operationCode");

-- Transformation indexes
CREATE UNIQUE INDEX "pv2_template_transformations_templateId_code_key" ON "pv2_template_transformations"("templateId", "code");
CREATE INDEX "pv2_template_transformations_templateId_idx" ON "pv2_template_transformations"("templateId");
CREATE INDEX "pv2_template_transformations_templateVersionId_idx" ON "pv2_template_transformations"("templateVersionId");
CREATE INDEX "pv2_template_transformations_type_idx" ON "pv2_template_transformations"("type");
CREATE INDEX "pv2_template_transformations_isGlobal_idx" ON "pv2_template_transformations"("isGlobal");

-- Error Mapping indexes
CREATE INDEX "pv2_template_error_mappings_templateId_idx" ON "pv2_template_error_mappings"("templateId");
CREATE INDEX "pv2_template_error_mappings_templateVersionId_idx" ON "pv2_template_error_mappings"("templateVersionId");
CREATE INDEX "pv2_template_error_mappings_httpStatus_idx" ON "pv2_template_error_mappings"("httpStatus");
CREATE INDEX "pv2_template_error_mappings_providerErrorCode_idx" ON "pv2_template_error_mappings"("providerErrorCode");
CREATE INDEX "pv2_template_error_mappings_normalizedCode_idx" ON "pv2_template_error_mappings"("normalizedCode");
CREATE INDEX "pv2_template_error_mappings_operationCode_idx" ON "pv2_template_error_mappings"("operationCode");

-- Policy indexes
CREATE UNIQUE INDEX "pv2_template_retry_policies_templateId_code_key" ON "pv2_template_retry_policies"("templateId", "code");
CREATE INDEX "pv2_template_retry_policies_templateId_idx" ON "pv2_template_retry_policies"("templateId");
CREATE UNIQUE INDEX "pv2_template_rate_limit_policies_templateId_key" ON "pv2_template_rate_limit_policies"("templateId");
CREATE UNIQUE INDEX "pv2_template_cache_policies_templateId_code_key" ON "pv2_template_cache_policies"("templateId", "code");
CREATE INDEX "pv2_template_cache_policies_templateId_idx" ON "pv2_template_cache_policies"("templateId");

-- Pagination indexes
CREATE UNIQUE INDEX "pv2_template_pagination_configs_endpointId_key" ON "pv2_template_pagination_configs"("endpointId");

-- Webhook indexes
CREATE UNIQUE INDEX "pv2_template_webhook_configs_templateId_eventCode_key" ON "pv2_template_webhook_configs"("templateId", "eventCode");
CREATE INDEX "pv2_template_webhook_configs_templateId_idx" ON "pv2_template_webhook_configs"("templateId");
CREATE INDEX "pv2_template_webhook_configs_templateVersionId_idx" ON "pv2_template_webhook_configs"("templateVersionId");
CREATE INDEX "pv2_template_webhook_configs_normalizedEvent_idx" ON "pv2_template_webhook_configs"("normalizedEvent");

-- Health Check indexes
CREATE INDEX "pv2_template_health_checks_templateId_idx" ON "pv2_template_health_checks"("templateId");
CREATE INDEX "pv2_template_health_checks_templateVersionId_idx" ON "pv2_template_health_checks"("templateVersionId");
CREATE INDEX "pv2_template_health_checks_operationId_idx" ON "pv2_template_health_checks"("operationId");

-- Sync Config indexes
CREATE UNIQUE INDEX "pv2_template_sync_configs_templateId_syncType_key" ON "pv2_template_sync_configs"("templateId", "syncType");
CREATE INDEX "pv2_template_sync_configs_templateId_idx" ON "pv2_template_sync_configs"("templateId");
CREATE INDEX "pv2_template_sync_configs_templateVersionId_idx" ON "pv2_template_sync_configs"("templateVersionId");
CREATE INDEX "pv2_template_sync_configs_syncType_idx" ON "pv2_template_sync_configs"("syncType");
CREATE INDEX "pv2_template_sync_configs_isActive_idx" ON "pv2_template_sync_configs"("isActive");

-- Pipeline indexes
CREATE UNIQUE INDEX "pv2_template_pipeline_configs_templateId_stage_key" ON "pv2_template_pipeline_configs"("templateId", "stage");
CREATE UNIQUE INDEX "pv2_template_pipeline_configs_templateVersionId_stage_key" ON "pv2_template_pipeline_configs"("templateVersionId", "stage");
CREATE INDEX "pv2_template_pipeline_configs_templateId_idx" ON "pv2_template_pipeline_configs"("templateId");
CREATE INDEX "pv2_template_pipeline_configs_templateVersionId_idx" ON "pv2_template_pipeline_configs"("templateVersionId");
CREATE INDEX "pv2_template_pipeline_configs_stage_idx" ON "pv2_template_pipeline_configs"("stage");

-- Event Bus indexes
CREATE INDEX "pv2_events_status_availableAt_idx" ON "pv2_events"("status", "availableAt");
CREATE INDEX "pv2_events_eventType_idx" ON "pv2_events"("eventType");
CREATE INDEX "pv2_events_aggregateType_aggregateId_idx" ON "pv2_events"("aggregateType", "aggregateId");
CREATE INDEX "pv2_events_providerId_idx" ON "pv2_events"("providerId");
CREATE INDEX "pv2_events_businessId_idx" ON "pv2_events"("businessId");
CREATE INDEX "pv2_events_createdAt_idx" ON "pv2_events"("createdAt");

-- Validation Rule indexes
CREATE UNIQUE INDEX "pv2_template_validation_rules_templateId_ruleCode_key" ON "pv2_template_validation_rules"("templateId", "ruleCode");
CREATE INDEX "pv2_template_validation_rules_templateId_idx" ON "pv2_template_validation_rules"("templateId");
CREATE INDEX "pv2_template_validation_rules_templateVersionId_idx" ON "pv2_template_validation_rules"("templateVersionId");
CREATE INDEX "pv2_template_validation_rules_severity_idx" ON "pv2_template_validation_rules"("severity");
CREATE INDEX "pv2_template_validation_rules_phase_idx" ON "pv2_template_validation_rules"("phase");
CREATE INDEX "pv2_template_validation_rules_category_idx" ON "pv2_template_validation_rules"("category");

-- ============================================================================
-- 11. FOREIGN KEYS
-- ============================================================================

-- Provider → Template FK
ALTER TABLE "providers" ADD CONSTRAINT "providers_pv2TemplateId_fkey" FOREIGN KEY ("pv2TemplateId") REFERENCES "pv2_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "providers" ADD CONSTRAINT "providers_pv2TemplateVersionId_fkey" FOREIGN KEY ("pv2TemplateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Feature Pack ↔ Operation FKs
ALTER TABLE "pv2_feature_pack_operations" ADD CONSTRAINT "pv2_feature_pack_operations_featurePackId_fkey" FOREIGN KEY ("featurePackId") REFERENCES "pv2_feature_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_feature_pack_operations" ADD CONSTRAINT "pv2_feature_pack_operations_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "pv2_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Template Version FK
ALTER TABLE "pv2_template_versions" ADD CONSTRAINT "pv2_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Template Feature Pack FKs
ALTER TABLE "pv2_template_feature_packs" ADD CONSTRAINT "pv2_template_feature_packs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_feature_packs" ADD CONSTRAINT "pv2_template_feature_packs_featurePackId_fkey" FOREIGN KEY ("featurePackId") REFERENCES "pv2_feature_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Provider Feature Pack Override FKs
ALTER TABLE "pv2_provider_feature_pack_overrides" ADD CONSTRAINT "pv2_provider_feature_pack_overrides_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_provider_feature_pack_overrides" ADD CONSTRAINT "pv2_provider_feature_pack_overrides_featurePackId_fkey" FOREIGN KEY ("featurePackId") REFERENCES "pv2_feature_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Auth Config FKs
ALTER TABLE "pv2_template_auth_configs" ADD CONSTRAINT "pv2_template_auth_configs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_auth_request_mappings" ADD CONSTRAINT "pv2_template_auth_request_mappings_authConfigId_fkey" FOREIGN KEY ("authConfigId") REFERENCES "pv2_template_auth_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_auth_response_mappings" ADD CONSTRAINT "pv2_template_auth_response_mappings_authConfigId_fkey" FOREIGN KEY ("authConfigId") REFERENCES "pv2_template_auth_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Endpoint FKs
ALTER TABLE "pv2_template_endpoints" ADD CONSTRAINT "pv2_template_endpoints_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoints" ADD CONSTRAINT "pv2_template_endpoints_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoints" ADD CONSTRAINT "pv2_template_endpoints_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "pv2_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoints" ADD CONSTRAINT "pv2_template_endpoints_cachePolicyId_fkey" FOREIGN KEY ("cachePolicyId") REFERENCES "pv2_template_cache_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoints" ADD CONSTRAINT "pv2_template_endpoints_retryPolicyId_fkey" FOREIGN KEY ("retryPolicyId") REFERENCES "pv2_template_retry_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Endpoint Param FKs
ALTER TABLE "pv2_template_endpoint_headers" ADD CONSTRAINT "pv2_template_endpoint_headers_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoint_query_params" ADD CONSTRAINT "pv2_template_endpoint_query_params_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoint_path_params" ADD CONSTRAINT "pv2_template_endpoint_path_params_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_endpoint_body_params" ADD CONSTRAINT "pv2_template_endpoint_body_params_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Field Mapping FKs
ALTER TABLE "pv2_template_field_mappings" ADD CONSTRAINT "pv2_template_field_mappings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_field_mappings" ADD CONSTRAINT "pv2_template_field_mappings_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_field_mappings" ADD CONSTRAINT "pv2_template_field_mappings_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Transformation FKs
ALTER TABLE "pv2_template_transformations" ADD CONSTRAINT "pv2_template_transformations_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_transformations" ADD CONSTRAINT "pv2_template_transformations_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Error Mapping FKs
ALTER TABLE "pv2_template_error_mappings" ADD CONSTRAINT "pv2_template_error_mappings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_error_mappings" ADD CONSTRAINT "pv2_template_error_mappings_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Policy FKs
ALTER TABLE "pv2_template_retry_policies" ADD CONSTRAINT "pv2_template_retry_policies_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_rate_limit_policies" ADD CONSTRAINT "pv2_template_rate_limit_policies_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_cache_policies" ADD CONSTRAINT "pv2_template_cache_policies_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pagination FK
ALTER TABLE "pv2_template_pagination_configs" ADD CONSTRAINT "pv2_template_pagination_configs_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "pv2_template_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Webhook FKs
ALTER TABLE "pv2_template_webhook_configs" ADD CONSTRAINT "pv2_template_webhook_configs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_webhook_configs" ADD CONSTRAINT "pv2_template_webhook_configs_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Health Check FKs
ALTER TABLE "pv2_template_health_checks" ADD CONSTRAINT "pv2_template_health_checks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_health_checks" ADD CONSTRAINT "pv2_template_health_checks_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_health_checks" ADD CONSTRAINT "pv2_template_health_checks_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "pv2_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sync Config FKs
ALTER TABLE "pv2_template_sync_configs" ADD CONSTRAINT "pv2_template_sync_configs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_sync_configs" ADD CONSTRAINT "pv2_template_sync_configs_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_sync_configs" ADD CONSTRAINT "pv2_template_sync_configs_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "pv2_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pipeline FKs
ALTER TABLE "pv2_template_pipeline_configs" ADD CONSTRAINT "pv2_template_pipeline_configs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_pipeline_configs" ADD CONSTRAINT "pv2_template_pipeline_configs_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Validation Rule FKs
ALTER TABLE "pv2_template_validation_rules" ADD CONSTRAINT "pv2_template_validation_rules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pv2_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_validation_rules" ADD CONSTRAINT "pv2_template_validation_rules_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "pv2_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pv2_template_validation_rules" ADD CONSTRAINT "pv2_template_validation_rules_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "pv2_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
