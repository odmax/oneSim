# Provider Framework V2 — Metadata-Driven Provider Engine

## Executive Summary

Provider Framework V2 replaces all hardcoded provider-specific branching with database-configured templates, enabling unlimited providers (including future IBASIS) without code changes. The architecture consists of:

1. **Enhanced ProviderTemplate Schema** — 13 new tables for comprehensive provider configuration
2. **Metadata-Driven Engines** — Core engine classes that interpret template configuration
3. **Normalized DTOs** — Common internal models for all provider data
4. **Thin Protocol Adapters** — Only for things that CANNOT be metadata-driven (OAuth, SOAP, GraphQL, HMAC, binary payloads)
5. **Template Installer** — Mechanism to install new providers from configuration
6. **Migration Strategy** — How to transition from current hardcoded approach

---

## 1. Database Schema Design

### 1.1 Core Template Table (Enhanced)

```prisma
model ProviderTemplate {
  id              String   @id @default(cuid())
  name            String   @unique // "CHOICE_ESIM", "TELNA_ESIM", "AIRHUB_ESIM", "IBASIS_ESIM"
  displayName     String   // "Choice eSIM"
  providerFamily  String   // "CHOICE", "TELNA", "AIRHUB", "IBASIS", "CUSTOM", "MOCK"
  isActive        Boolean  @default(true)
  isDefault       Boolean  @default(false) // Default template for this provider family
  
  // Capability Matrix
  supportedCapabilities String[] // ["CATALOG", "ORDER", "ACTIVATION", "USAGE", "BALANCE", "SUSPEND", "RESUME", "REFUND", "WEBHOOK", "REAL_TIME_USAGE", "MULTI_IMSI", "PARTNER_CODES"]
  capabilityMatrix      Json?   // { "catalog": { "supported": true, "fields": ["iccid", "mdn", "msisdn", "imsi"] }, ... }
  
  // Auth Strategy
  authStrategy    String   // "NONE", "API_KEY", "OAUTH2", "OAUTH1", "SOAP", "HMAC", "BASIC", "BEARER_TOKEN"
  authConfig      Json     // Strategy-specific config (see ProviderTemplateAuth)
  
  // Protocol Configuration
  protocolType    String   // "REST", "SOAP", "GRAPHQL", "FIXED"
  protocolConfig  Json?    // Protocol-specific settings (see ProviderTemplateProtocol)
  
  // Base URL Configuration
  baseUrl         String?  // Main API base URL
  baseUrlDev      String?  // Development base URL
  baseUrlStaging  String?  // Staging base URL
  
  // Webhook Configuration
  webhookConfig   Json?    // See ProviderTemplateWebhook
  
  // Error Mapping Configuration
  errorMapping    Json?    // See ProviderTemplateErrorMapping
  
  // Retry Configuration
  retryConfig     Json?    // See ProviderTemplateRetry
  
  // Rate Limiting
  rateLimitConfig Json?    // See ProviderTemplateRateLimit
  
  // Health Check Configuration
  healthCheckConfig Json?  // See ProviderTemplateHealthCheck
  
  // Sync Configuration
  syncConfig      Json?    // See ProviderTemplateSync
  
  // Metadata
  description     String?
  version         Int      @default(1)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  // Relationships
  providers       Provider[]
  endpoints       ProviderTemplateEndpoint[]
  headers         ProviderTemplateHeader[]
  requestMappings ProviderTemplateRequestMapping[]
  responseMappings ProviderTemplateResponseMapping[]
  webhooks        ProviderTemplateWebhookConfig[]
  errorMappings   ProviderTemplateErrorMappingConfig[]
  
  @@index([providerFamily])
  @@index([isActive])
}
```

### 1.2 Endpoint Definitions

```prisma
model ProviderTemplateEndpoint {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  operation       String   // "CATALOG", "ORDER", "ACTIVATION", "STATUS", "USAGE", "BALANCE", "SUSPEND", "RESUME", "REFUND", "CUSTOM_1", "CUSTOM_2"
  name            String   // "listPlans", "activateESIM", "getUsage", etc.
  
  // HTTP Configuration
  method          String   @default("GET") // "GET", "POST", "PUT", "PATCH", "DELETE"
  path            String   // "/api/v1/plans", "/api/v1/orders"
  fullPath        String?  // Full URL override (if different from base)
  
  // Request Configuration
  requestBody     Json?    // Request body template (see RequestBodyTemplate)
  requestQuery    Json?    // Query parameters template
  requestParams   Json?    // URL parameters template
  
  // Response Configuration
  responseMapping Json     // See ResponseMappingTemplate
  
  // Pagination Configuration
  pagination      Json?    // See PaginationConfig
  
  // Timeout
  timeoutMs       Int      @default(30000)
  
  // Whether this endpoint requires authentication
  requiresAuth    Boolean  @default(true)
  
  // Custom headers for this endpoint
  customHeaders   Json?    // Additional headers specific to this endpoint
  
  // Error handling
  errorPaths      Json?    // Paths to extract errors from response
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, operation])
  @@index([templateId])
}
```

### 1.3 Header Templates

```prisma
model ProviderTemplateHeader {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  key             String   // "X-API-Key", "Authorization", "X-Partner-Id"
  value           String?  // Static value or template expression
  isSecret        Boolean  @default(false) // Mask in logs
  isDynamic       Boolean  @default(false) // Computed at runtime
  dynamicExpression String? // Expression to compute value
  
  operation       String?  // null = global, or specific operation
  priority        Int      @default(0) // Lower = higher priority
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, key, operation])
  @@index([templateId])
}
```

### 1.4 Request/Response Mappings

```prisma
model ProviderTemplateRequestMapping {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  operation       String   // Same as endpoint operation
  internalField   String   // "iccid", "msisdn", "carrier", "planId", "quantity", "callbackUrl", "metadata"
  externalField   String   // Provider-specific field name
  dataType        String   @default("STRING") // "STRING", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT", "JSON"
  isRequired      Boolean  @default(false)
  defaultValue    String?  // Default value if not provided
  transform       String?  // Transform expression (e.g., "toUpperCase", "formatDate", "custom:...")
  validation      Json?    // Validation rules (see FieldValidation)
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, operation, internalField])
  @@index([templateId])
  @@index([operation])
}

model ProviderTemplateResponseMapping {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  operation       String   // Same as endpoint operation
  internalField   String   // Normalized field name
  externalPath    String   // JSONPath or dot-notation to provider response
  dataType        String   @default("STRING")
  isRequired      Boolean  @default(false)
  defaultValue    String?
  transform       String?  // Transform expression
  nestedMapping   Json?    // For complex nested objects
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, operation, internalField])
  @@index([templateId])
  @@index([operation])
}
```

### 1.5 Webhook Configuration

```prisma
model ProviderTemplateWebhookConfig {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  event           String   // "ACTIVATED", "SUSPENDED", "RESUMED", "USAGE_UPDATE", "BALANCE_UPDATE", "ORDER_UPDATE"
  externalEvent   String   // Provider-specific event name
  payloadMapping   Json     // Mapping from provider webhook payload to internal
  
  // Normalization rules
  extractFields   Json?    // Fields to extract from nested structures
  transformRules  Json?    // Transform rules for extracted fields
  
  // Filtering
  filterConditions Json?   // Conditions to filter events
  
  // Routing
  targetTable     String?  // Target table to update
  targetField     String?  // Target field to update
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, event])
  @@index([templateId])
}
```

### 1.6 Error Mapping

```prisma
model ProviderTemplateErrorMappingConfig {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  providerCode    String   // Provider-specific error code
  internalCode    String   // Normalized internal error code
  messageTemplate String?  // Custom error message
  retryable       Boolean  @default(false) // Whether this error is retryable
  category        String   @default("UNKNOWN") // "AUTH", "VALIDATION", "NOT_FOUND", "RATE_LIMIT", "SERVER", "NETWORK", "UNKNOWN"
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId, providerCode])
  @@index([templateId])
}
```

### 1.7 Retry Configuration

```prisma
model ProviderTemplateRetry {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  maxAttempts     Int      @default(3)
  baseDelayMs     Int      @default(1000)
  maxDelayMs      Int      @default(30000)
  backoffType     String   @default("EXPONENTIAL") // "FIXED", "LINEAR", "EXPONENTIAL"
  jitter          Boolean  @default(true)
  
  retryableErrors String[] // Error codes that trigger retry
  retryableStatusCodes Int[] // HTTP status codes that trigger retry
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId])
}
```

### 1.8 Rate Limiting

```prisma
model ProviderTemplateRateLimit {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  requestsPerSecond Int    @default(10)
  requestsPerMinute Int    @default(600)
  requestsPerHour   Int    @default(36000)
  burstSize         Int    @default(20)
  
  algorithm       String   @default("TOKEN_BUCKET") // "FIXED_WINDOW", "SLIDING_WINDOW", "TOKEN_BUCKET"
  windowMs        Int      @default(1000) // Window size in milliseconds
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId])
}
```

### 1.9 Health Check Configuration

```prisma
model ProviderTemplateHealthCheck {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  endpoint        String   // Health check endpoint
  method          String   @default("GET")
  timeoutMs       Int      @default(5000)
  intervalMs      Int      @default(60000) // Check every minute
  
  expectedStatus  Int      @default(200)
  expectedBody    Json?    // Expected response body
  
  alertThreshold  Int      @default(3) // Consecutive failures before alert
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId])
}
```

### 1.10 Sync Configuration

```prisma
model ProviderTemplateSyncConfig {
  id              String   @id @default(cuid())
  templateId      String
  template        ProviderTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  
  // Catalog Sync
  catalogSyncEnabled Boolean @default(true)
  catalogSyncInterval Int   @default(3600000) // 1 hour in ms
  catalogSyncFields  String[] // Fields to sync: ["planId", "name", "description", "price", "currency", "dataAmount", "validity", "features", "restrictions", "metadata"]
  
  // Pricing Sync
  pricingSyncEnabled Boolean @default(true)
  pricingSyncInterval Int  @default(1800000) // 30 minutes
  pricingFields       String[] // ["price", "currency", "markup", "wholesalePrice"]
  
  // Status Sync
  statusSyncEnabled Boolean @default(true)
  statusSyncInterval Int  @default(300000) // 5 minutes
  
  // Batch Size
  batchSize        Int     @default(50)
  maxConcurrent    Int     @default(5)
  
  // Conflict Resolution
  conflictStrategy String  @default("PROVIDER_WINS") // "PROVIDER_WINS", "LOCAL_WINS", "MERGE", "MANUAL"
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([templateId])
}
```

---

## 2. Engine Architecture

### 2.1 Core Engine Interfaces

```typescript
// src/lib/providers/v2/interfaces/engines.ts

export interface IProviderEngine {
  readonly template: ProviderTemplate;
  readonly adapters: IProtocolAdapters;
  
  // Core operations
  authenticate(providerAccount: ProviderAccount): Promise<AuthResult>
  executeOperation(
    operation: string,
    providerAccount: ProviderAccount,
    input: NormalizedInput,
    context: ExecutionContext
  ): Promise<NormalizedOutput>
  
  // Capability checking
  supportsCapability(capability: string): boolean
  getCapabilities(): string[]
  
  // Health & status
  healthCheck(): Promise<HealthStatus>
  getMetrics(): ProviderMetrics
}

export interface IProtocolAdapters {
  oauth?: IOAuthAdapter
  soap?: ISoapAdapter
  graphql?: IGraphQLAdapter
  hmac?: IHMACAdapter
  custom?: ICustomProtocolAdapter
}

// Authentication Engine
export interface IAuthenticationEngine {
  authenticate(
    config: AuthConfig,
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult>
  
  refreshToken(
    config: AuthConfig,
    credentials: AuthCredentials,
    context: ExecutionContext
  ): Promise<AuthResult>
  
  validateCredentials(
    config: AuthConfig,
    credentials: AuthCredentials
  ): Promise<boolean>
}

// Endpoint Engine
export interface IEndpointEngine {
  resolveEndpoint(
    operation: string,
    providerAccount: ProviderAccount,
    endpointConfig: EndpointConfig
  ): Promise<ResolvedEndpoint>
  
  buildRequest(
    endpoint: ResolvedEndpoint,
    input: NormalizedInput,
    authResult: AuthResult
  ): Promise<BuiltRequest>
  
  executeRequest(
    request: BuiltRequest,
    context: ExecutionContext
  ): Promise<RawResponse>
}

// Request Builder
export interface IRequestBuilder {
  buildBody(
    template: RequestBodyTemplate,
    input: NormalizedInput,
    mapping: FieldMapping[]
  ): Promise<Record<string, any>>
  
  buildQuery(
    template: QueryTemplate,
    input: NormalizedInput,
    mapping: FieldMapping[]
  ): Promise<Record<string, string>>
  
  buildHeaders(
    template: HeaderTemplate,
    authResult: AuthResult,
    operation: string
  ): Promise<Record<string, string>>
  
  applyTransforms(
    data: Record<string, any>,
    transforms: TransformRule[]
  ): Promise<Record<string, any>>
}

// Response Mapper
export interface IResponseMapper {
  mapResponse<T>(
    rawResponse: RawResponse,
    mapping: ResponseMapping[],
    targetType: new () => T
  ): Promise<T>
  
  extractField(
    response: any,
    path: string,
    dataType: string
  ): Promise<any>
  
  applyTransforms(
    data: any,
    transforms: TransformRule[]
  ): Promise<any>
}

// Capability Engine
export interface ICapabilityEngine {
  supportsOperation(operation: string): boolean
  getSupportedOperations(): string[]
  validateOperationInput(
    operation: string,
    input: NormalizedInput
  ): ValidationResult
  getFieldRequirements(
    operation: string
  ): FieldRequirement[]
}

// Webhook Engine
export interface IWebhookEngine {
  normalizeEvent(
    rawPayload: any,
    template: WebhookConfig
  ): Promise<NormalizedWebhookEvent>
  
  routeEvent(
    event: NormalizedWebhookEvent,
    providerAccount: ProviderAccount
  ): Promise<EventRoute>
  
  validateSignature(
    payload: any,
    signature: string,
    secret: string
  ): Promise<boolean>
}

// Sync Engine
export interface ISyncEngine {
  syncCatalog(
    providerAccount: ProviderAccount,
    options: SyncOptions
  ): Promise<SyncResult>
  
  syncPricing(
    providerAccount: ProviderAccount,
    options: SyncOptions
  ): Promise<SyncResult>
  
  syncStatus(
    providerAccount: ProviderAccount,
    options: SyncOptions
  ): Promise<SyncResult>
  
  getSyncStatus(
    providerAccount: ProviderAccount
  ): Promise<SyncStatus>
}

// Error Mapping Engine
export interface IErrorMappingEngine {
  mapError(
    providerError: any,
    template: ErrorMappingConfig
  ): Promise<NormalizedError>
  
  isRetryable(error: NormalizedError): boolean
  getErrorCategory(error: NormalizedError): string
}

// Retry Engine
export interface IRetryEngine {
  shouldRetry(
    error: NormalizedError,
    attempt: number,
    config: RetryConfig
  ): Promise<boolean>
  
  getDelay(
    attempt: number,
    config: RetryConfig
  ): Promise<number>
}
```

### 2.2 Engine Implementation Architecture

```
src/lib/providers/v2/
├── engines/
│   ├── provider-engine.ts          # Main orchestrator
│   ├── authentication-engine.ts    # Auth from template config
│   ├── endpoint-engine.ts          # Endpoint resolution & request execution
│   ├── request-builder.ts          # Request construction from templates
│   ├── response-mapper.ts          # Response mapping to normalized DTOs
│   ├── capability-engine.ts        # Capability checking & validation
│   ├── webhook-engine.ts           # Webhook normalization
│   ├── sync-engine.ts              # Catalog/pricing/status sync
│   ├── error-mapping-engine.ts     # Error normalization
│   ├── retry-engine.ts             # Retry logic with backoff
│   └── health-check-engine.ts      # Health monitoring
├── adapters/
│   ├── oauth-adapter.ts            # OAuth 1.0/2.0
│   ├── soap-adapter.ts             # SOAP/XML
│   ├── graphql-adapter.ts          # GraphQL
│   ├── hmac-adapter.ts             # HMAC signing
│   └── protocol-adapter.ts         # Generic protocol adapter
├── dto/
│   ├── normalized-dtos.ts          # All normalized DTOs
│   └── index.ts
├── template-installer/
│   ├── template-installer.ts       # Installs templates from config
│   ├── template-validator.ts       # Validates template config
│   └── template-migrator.ts        # Migrates existing providers
├── interfaces/
│   ├── engines.ts                  # Engine interfaces
│   ├── adapters.ts                 # Adapter interfaces
│   └── dto.ts                      # DTO interfaces
├── utils/
│   ├── template-utils.ts           # Template manipulation utilities
│   ├── expression-evaluator.ts     # Dynamic expression evaluation
│   └── validation-utils.ts         # Validation utilities
├── index.ts                        # Public API
└── README.md                       # Architecture documentation
```

---

## 3. Normalized DTOs

### 3.1 Core DTOs

```typescript
// src/lib/providers/v2/dto/normalized-dtos.ts

// Base interface for all normalized outputs
export interface NormalizedOutput {
  success: boolean
  providerId: string
  providerAccountId: string
  operation: string
  timestamp: Date
  requestId: string
  metadata?: Record<string, any>
}

// Catalog Product (normalized from provider)
export interface NormalizedCatalogProduct extends NormalizedOutput {
  planId: string
  name: string
  description?: string
  providerName?: string
  category?: string
  planType?: string
  networkType?: string
  dataAmount?: string
  dataAmountBytes?: number
  validity?: number
  validityUnit?: string
  currency?: string
  price?: number
  wholesalePrice?: number
  retailPrice?: number
  markup?: number
  features?: string[]
  restrictions?: string[]
  metadata?: Record<string, any>
}

// ESim (normalized)
export interface NormalizedESim extends NormalizedOutput {
  iccid?: string
  eid?: string
  msisdn?: string
  imsi?: string
  mdn?: string
  carrier?: string
  planId?: string
  planName?: string
  status?: string
  activationDate?: Date
  expirationDate?: Date
  dataUsed?: number
  dataLimit?: number
  dataRemaining?: number
  createdAt?: Date
  updatedAt?: Date
}

// Order (normalized)
export interface NormalizedOrder extends NormalizedOutput {
  orderId: string
  externalOrderId?: string
  status?: string
  quantity?: number
  iccid?: string
  planId?: string
  totalPrice?: number
  currency?: string
  createdAt?: Date
  estimatedDelivery?: Date
}

// Customer (normalized)
export interface NormalizedCustomer extends NormalizedOutput {
  customerId?: string
  externalCustomerId?: string
  name?: string
  email?: string
  phone?: string
  company?: string
  address?: NormalizedAddress
  metadata?: Record<string, any>
}

// Subscription (normalized)
export interface NormalizedSubscription extends NormalizedOutput {
  subscriptionId?: string
  externalSubscriptionId?: string
  iccid?: string
  planId?: string
  planName?: string
  status?: string
  startDate?: Date
  endDate?: Date
  renewalDate?: Date
  autoRenew?: boolean
  dataUsed?: number
  dataLimit?: number
}

// Usage (normalized)
export interface NormalizedUsage extends NormalizedOutput {
  iccid?: string
  dataUsed?: number
  dataLimit?: number
  dataRemaining?: number
  dataUsedFormatted?: string
  dataLimitFormatted?: string
  voiceUsed?: number
  voiceLimit?: number
  smsUsed?: number
  smsLimit?: number
  billingPeriod?: {
    start: Date
    end: Date
  }
  lastUpdated?: Date
}

// Balance (normalized)
export interface NormalizedBalance extends NormalizedOutput {
  balance?: number
  currency?: string
  balanceFormatted?: string
  balanceType?: string // "PREPAID", "POSTPAID", "CREDIT"
  lastUpdated?: Date
}

// Notification (normalized from webhook)
export interface NormalizedNotification extends NormalizedOutput {
  notificationId?: string
  event: string
  iccid?: string
  orderId?: string
  status?: string
  message?: string
  data?: Record<string, any>
  timestamp?: Date
}

// Provider Error (normalized)
export interface NormalizedError {
  success: false
  providerId: string
  providerAccountId: string
  operation: string
  timestamp: Date
  requestId: string
  
  errorCode: string
  errorMessage: string
  providerErrorCode?: string
  providerErrorMessage?: string
  category: string // "AUTH", "VALIDATION", "NOT_FOUND", "RATE_LIMIT", "SERVER", "NETWORK", "UNKNOWN"
  retryable: boolean
  httpStatus?: number
  details?: Record<string, any>
  stack?: string
}

// Address (normalized)
export interface NormalizedAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

// Auth Result
export interface AuthResult {
  success: boolean
  token?: string
  refreshToken?: string
  expiresAt?: Date
  tokenType?: string
  credentials?: Record<string, any>
  error?: string
}

// Validation Result
export interface ValidationResult {
  valid: boolean
  errors?: ValidationError[]
  warnings?: ValidationError[]
}

export interface ValidationError {
  field: string
  message: string
  code: string
  severity?: "error" | "warning"
}

// Field Requirement
export interface FieldRequirement {
  field: string
  required: boolean
  type: string
  description?: string
  validation?: Record<string, any>
}

// Health Status
export interface HealthStatus {
  healthy: boolean
  provider: string
  responseTime?: number
  lastCheck: Date
  error?: string
  details?: Record<string, any>
}

// Provider Metrics
export interface ProviderMetrics {
  requestsTotal: number
  requestsSuccessful: number
  requestsFailed: number
  averageResponseTime: number
  errorRate: number
  rateLimitHits: number
  lastRequest?: Date
}
```

### 3.2 Supporting Types

```typescript
// src/lib/providers/v2/interfaces/dto.ts

export interface ExecutionContext {
  requestId: string
  timestamp: Date
  userId?: string
  sessionId?: string
  ipAddress?: string
  userAgent?: string
  correlationId?: string
  metadata?: Record<string, any>
}

export interface NormalizedInput {
  operation: string
  iccid?: string
  eid?: string
  msisdn?: string
  imsi?: string
  mdn?: string
  carrier?: string
  planId?: string
  quantity?: number
  callbackUrl?: string
  metadata?: Record<string, any>
  [key: string]: any
}

export interface ResolvedEndpoint {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
  query?: Record<string, string>
  timeoutMs: number
}

export interface BuiltRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
  query?: Record<string, string>
  timeoutMs: number
  requestId: string
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  body: any
  responseTime: number
  requestId: string
}

export interface SyncOptions {
  force?: boolean
  dryRun?: boolean
  batchSize?: number
  maxConcurrent?: number
  fields?: string[]
  startDate?: Date
  endDate?: Date
}

export interface SyncResult {
  success: boolean
  operation: string
  totalRecords: number
  successful: number
  failed: number
  errors?: NormalizedError[]
  duration: number
  timestamp: Date
}

export interface SyncStatus {
  lastSync?: Date
  inProgress: boolean
  progress?: number
  errors?: NormalizedError[]
}

export interface EventRoute {
  target: string // "order", "esim", "subscription", "usage", "balance", "notification"
  action: string // "update", "create", "notify"
  params: Record<string, any>
}

export interface NormalizedWebhookEvent {
  eventId: string
  event: string
  provider: string
  timestamp: Date
  payload: any
  signature?: string
  rawPayload: any
}

// Template expression types
export interface TransformRule {
  type: string // "toUpperCase", "toLowerCase", "formatDate", "custom", "concat", "split", "replace", "default"
  params?: Record<string, any>
  expression?: string // For custom transforms
}

export interface FieldMapping {
  internal: string
  external: string
  dataType: string
  required: boolean
  defaultValue?: any
  transform?: TransformRule[]
  validation?: Record<string, any>
}

// Auth Config types
export interface AuthConfig {
  strategy: string // "NONE", "API_KEY", "OAUTH2", "OAUTH1", "SOAP", "HMAC", "BASIC", "BEARER_TOKEN"
  
  // OAuth2 specific
  authorizationUrl?: string
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  scopes?: string[]
  grantType?: string
  
  // API Key specific
  apiKeyHeader?: string
  apiKeyParam?: string
  
  // HMAC specific
  hmacAlgorithm?: string
  hmacSecret?: string
  hmacHeaders?: string[]
  
  // SOAP specific
  soapVersion?: string
  soapNamespace?: string
  soapAction?: string
  
  // Basic Auth specific
  username?: string
  password?: string
  
  // Token specific
  tokenHeader?: string
  tokenPrefix?: string
}

// Protocol Config types
export interface ProtocolConfig {
  type: string // "REST", "SOAP", "GRAPHQL", "FIXED"
  
  // SOAP specific
  soapVersion?: string
  soapNamespace?: string
  soapEnvelope?: string
  
  // GraphQL specific
  graphqlEndpoint?: string
  graphqlQuery?: string
  
  // REST specific
  restVersion?: string
  
  // Fixed specific
  fixedFormat?: string
}

// Pagination Config
export interface PaginationConfig {
  type: string // "NONE", "OFFSET", "CURSOR", "PAGE", "LINK"
  
  // Offset/Page
  pageParam?: string
  limitParam?: string
  offsetParam?: string
  
  // Cursor
  cursorParam?: string
  cursorField?: string
  
  // Link
  linkHeader?: string
  
  // Defaults
  defaultPage?: number
  defaultLimit?: number
  maxLimit?: number
  
  // Response paths
  totalPath?: string
  hasMorePath?: string
  nextPagePath?: string
}

// Retry Config
export interface RetryConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  backoffType: string // "FIXED", "LINEAR", "EXPONENTIAL"
  jitter: boolean
  retryableErrors: string[]
  retryableStatusCodes: number[]
}

// Rate Limit Config
export interface RateLimitConfig {
  requestsPerSecond: number
  requestsPerMinute: number
  requestsPerHour: number
  burstSize: number
  algorithm: string // "FIXED_WINDOW", "SLIDING_WINDOW", "TOKEN_BUCKET"
  windowMs: number
}

// Health Check Config
export interface HealthCheckConfig {
  endpoint: string
  method: string
  timeoutMs: number
  intervalMs: number
  expectedStatus: number
  expectedBody?: any
  alertThreshold: number
}
```

---

## 4. Provider Engine Implementation

### 4.1 Main Provider Engine

```typescript
// src/lib/providers/v2/engines/provider-engine.ts

import { ProviderEngineConfig, ProviderTemplate, ProviderAccount } from '@prisma/client'
import { IProviderEngine, IProtocolAdapters } from '../interfaces/engines'
import { AuthenticationEngine } from './authentication-engine'
import { EndpointEngine } from './endpoint-engine'
import { RequestBuilder } from './request-builder'
import { ResponseMapper } from './response-mapper'
import { CapabilityEngine } from './capability-engine'
import { ErrorMappingEngine } from './error-mapping-engine'
import { RetryEngine } from './retry-engine'
import { ExecutionContext, NormalizedInput, NormalizedOutput, AuthResult } from '../interfaces/dto'
import { generateUUID } from '@/lib/utils'
import { logger } from '@/lib/utils/logger'

export class ProviderEngine implements IProviderEngine {
  readonly template: ProviderTemplate
  readonly adapters: IProtocolAdapters
  
  private authEngine: AuthenticationEngine
  private endpointEngine: EndpointEngine
  private requestBuilder: RequestBuilder
  private responseMapper: ResponseMapper
  private capabilityEngine: CapabilityEngine
  private errorMappingEngine: ErrorMappingEngine
  private retryEngine: RetryEngine
  
  constructor(template: ProviderTemplate, adapters: IProtocolAdapters = {}) {
    this.template = template
    this.adapters = adapters
    
    this.authEngine = new AuthenticationEngine(template.authConfig as any, adapters)
    this.endpointEngine = new EndpointEngine(template)
    this.requestBuilder = new RequestBuilder(template)
    this.responseMapper = new ResponseMapper(template)
    this.capabilityEngine = new CapabilityEngine(template)
    this.errorMappingEngine = new ErrorMappingEngine(template)
    this.retryEngine = new RetryEngine(template.retryConfig as any)
  }
  
  async authenticate(
    providerAccount: ProviderAccount,
    context?: ExecutionContext
  ): Promise<AuthResult> {
    const ctx = context || this.createContext('authenticate')
    
    try {
      return await this.authEngine.authenticate(
        providerAccount,
        ctx
      )
    } catch (error) {
      logger.error('Authentication failed', {
        templateId: this.template.id,
        providerAccountId: providerAccount.id,
        error: error.message,
        requestId: ctx.requestId
      })
      
      return {
        success: false,
        error: error.message
      }
    }
  }
  
  async executeOperation(
    operation: string,
    providerAccount: ProviderAccount,
    input: NormalizedInput,
    context?: ExecutionContext
  ): Promise<NormalizedOutput> {
    const ctx = context || this.createContext(operation)
    const startTime = Date.now()
    
    try {
      // Validate capability
      if (!this.capabilityEngine.supportsOperation(operation)) {
        throw new Error(`Operation ${operation} not supported by provider ${this.template.name}`)
      }
      
      // Validate input
      const validation = this.capabilityEngine.validateOperationInput(operation, input)
      if (!validation.valid) {
        throw new Error(`Invalid input: ${validation.errors?.map(e => e.message).join(', ')}`)
      }
      
      // Authenticate
      const authResult = await this.authenticate(providerAccount, ctx)
      if (!authResult.success) {
        throw new Error(`Authentication failed: ${authResult.error}`)
      }
      
      // Resolve endpoint
      const endpoint = await this.endpointEngine.resolveEndpoint(
        operation,
        providerAccount,
        this.getEndpointConfig(operation)
      )
      
      // Build request
      const request = await this.requestBuilder.buildRequest(
        endpoint,
        input,
        authResult
      )
      
      // Execute with retry
      const response = await this.retryEngine.executeWithRetry(
        async () => {
          return await this.endpointEngine.executeRequest(request, ctx)
        },
        operation
      )
      
      // Map response
      const result = await this.responseMapper.mapResponse(
        response,
        this.getResponseMapping(operation)
      )
      
      // Add common fields
      result.providerId = this.template.id
      result.providerAccountId = providerAccount.id
      result.operation = operation
      result.timestamp = new Date()
      result.requestId = ctx.requestId
      
      return result
      
    } catch (error) {
      // Map error
      const normalizedError = await this.errorMappingEngine.mapError(
        error,
        this.getErrorResponseMapping(operation)
      )
      
      logger.error('Operation failed', {
        templateId: this.template.id,
        providerAccountId: providerAccount.id,
        operation,
        error: normalizedError.errorMessage,
        errorCode: normalizedError.errorCode,
        requestId: ctx.requestId,
        duration: Date.now() - startTime
      })
      
      return {
        success: false,
        providerId: this.template.id,
        providerAccountId: providerAccount.id,
        operation,
        timestamp: new Date(),
        requestId: ctx.requestId,
        ...normalizedError
      } as any
    }
  }
  
  supportsCapability(capability: string): boolean {
    return this.capabilityEngine.supportsOperation(capability)
  }
  
  getCapabilities(): string[] {
    return this.capabilityEngine.getSupportedOperations()
  }
  
  async healthCheck(): Promise<HealthStatus> {
    // Implementation depends on health check config
    return {
      healthy: true,
      provider: this.template.name,
      lastCheck: new Date()
    }
  }
  
  getMetrics(): ProviderMetrics {
    // TODO: Implement metrics collection
    return {
      requestsTotal: 0,
      requestsSuccessful: 0,
      requestsFailed: 0,
      averageResponseTime: 0,
      errorRate: 0,
      rateLimitHits: 0
    }
  }
  
  private createContext(operation: string): ExecutionContext {
    return {
      requestId: generateUUID(),
      timestamp: new Date()
    }
  }
  
  private getEndpointConfig(operation: string): any {
    // Get endpoint config from template
    const endpoint = (this.template as any).endpoints?.find(
      (e: any) => e.operation === operation
    )
    
    if (!endpoint) {
      throw new Error(`No endpoint configured for operation: ${operation}`)
    }
    
    return endpoint
  }
  
  private getResponseMapping(operation: string): any {
    // Get response mapping from template
    const endpoint = (this.template as any).endpoints?.find(
      (e: any) => e.operation === operation
    )
    
    return endpoint?.responseMapping || []
  }
  
  private getErrorResponseMapping(operation: string): any {
    // Get error mapping from template
    return (this.template as any).errorMapping || {}
  }
}
```

### 4.2 Authentication Engine

```typescript
// src/lib/providers/v2/engines/authentication-engine.ts

import { AuthConfig, AuthResult, ExecutionContext } from '../interfaces/dto'
import { IProtocolAdapters } from '../interfaces/engines'
import { ProviderAccount } from '@prisma/client'
import { logger } from '@/lib/utils/logger'

export class AuthenticationEngine {
  private config: AuthConfig
  private adapters: IProtocolAdapters
  
  constructor(config: AuthConfig, adapters: IProtocolAdapters = {}) {
    this.config = config
    this.adapters = adapters
  }
  
  async authenticate(
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    try {
      switch (this.config.strategy) {
        case 'NONE':
          return { success: true }
          
        case 'API_KEY':
          return this.authenticateApiKey(providerAccount)
          
        case 'OAUTH2':
          return this.authenticateOAuth2(providerAccount, context)
          
        case 'OAUTH1':
          return this.authenticateOAuth1(providerAccount, context)
          
        case 'SOAP':
          return this.authenticateSoap(providerAccount, context)
          
        case 'HMAC':
          return this.authenticateHmac(providerAccount, context)
          
        case 'BASIC':
          return this.authenticateBasic(providerAccount)
          
        case 'BEARER_TOKEN':
          return this.authenticateBearer(providerAccount)
          
        default:
          throw new Error(`Unknown auth strategy: ${this.config.strategy}`)
      }
    } catch (error) {
      logger.error('Authentication failed', {
        strategy: this.config.strategy,
        providerAccountId: providerAccount.id,
        error: error.message,
        requestId: context.requestId
      })
      
      return {
        success: false,
        error: error.message
      }
    }
  }
  
  async refreshToken(
    credentials: any,
    context: ExecutionContext
  ): Promise<AuthResult> {
    if (this.config.strategy !== 'OAUTH2') {
      throw new Error(`Token refresh not supported for strategy: ${this.config.strategy}`)
    }
    
    if (!this.adapters.oauth) {
      throw new Error('OAuth adapter not configured')
    }
    
    return this.adapters.oauth.refreshToken(
      this.config,
      credentials,
      context
    )
  }
  
  private async authenticateApiKey(
    providerAccount: ProviderAccount
  ): Promise<AuthResult> {
    const apiKey = providerAccount.apiKey || providerAccount.credentials?.apiKey
    
    if (!apiKey) {
      throw new Error('API key not configured')
    }
    
    const credentials: Record<string, any> = {
      [this.config.apiKeyHeader || 'X-API-Key']: apiKey
    }
    
    return {
      success: true,
      token: apiKey,
      tokenType: 'API_KEY',
      credentials
    }
  }
  
  private async authenticateOAuth2(
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    if (!this.adapters.oauth) {
      throw new Error('OAuth adapter not configured')
    }
    
    return this.adapters.oauth.authenticate(
      this.config,
      providerAccount,
      context
    )
  }
  
  private async authenticateOAuth1(
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    if (!this.adapters.oauth) {
      throw new Error('OAuth adapter not configured')
    }
    
    return this.adapters.oauth.authenticate(
      this.config,
      providerAccount,
      context
    )
  }
  
  private async authenticateSoap(
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    if (!this.adapters.soap) {
      throw new Error('SOAP adapter not configured')
    }
    
    return this.adapters.soap.authenticate(
      this.config,
      providerAccount,
      context
    )
  }
  
  private async authenticateHmac(
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    if (!this.adapters.hmac) {
      throw new Error('HMAC adapter not configured')
    }
    
    return this.adapters.hmac.authenticate(
      this.config,
      providerAccount,
      context
    )
  }
  
  private async authenticateBasic(
    providerAccount: ProviderAccount
  ): Promise<AuthResult> {
    const username = providerAccount.credentials?.username
    const password = providerAccount.credentials?.password
    
    if (!username || !password) {
      throw new Error('Basic auth credentials not configured')
    }
    
    const token = Buffer.from(`${username}:${password}`).toString('base64')
    
    return {
      success: true,
      token,
      tokenType: 'BASIC',
      credentials: {
        Authorization: `Basic ${token}`
      }
    }
  }
  
  private async authenticateBearer(
    providerAccount: ProviderAccount
  ): Promise<AuthResult> {
    const token = providerAccount.credentials?.token
    
    if (!token) {
      throw new Error('Bearer token not configured')
    }
    
    return {
      success: true,
      token,
      tokenType: 'BEARER',
      credentials: {
        Authorization: `Bearer ${token}`
      }
    }
  }
}
```

### 4.3 Endpoint Engine

```typescript
// src/lib/providers/v2/engines/endpoint-engine.ts

import { ProviderTemplate } from '@prisma/client'
import { ResolvedEndpoint, BuiltRequest, RawResponse, ExecutionContext, NormalizedInput, AuthResult } from '../interfaces/dto'
import { logger } from '@/lib/utils/logger'
import { generateUUID } from '@/lib/utils'

export class EndpointEngine {
  private template: ProviderTemplate
  
  constructor(template: ProviderTemplate) {
    this.template = template
  }
  
  async resolveEndpoint(
    operation: string,
    providerAccount: ProviderAccount,
    endpointConfig: any
  ): Promise<ResolvedEndpoint> {
    const { method, path, fullPath, timeoutMs, customHeaders } = endpointConfig
    
    // Resolve base URL
    const baseUrl = this.resolveBaseUrl(providerAccount)
    
    // Resolve path with variables
    const resolvedPath = this.resolvePath(path, providerAccount)
    
    // Build full URL
    const url = fullPath || `${baseUrl}${resolvedPath}`
    
    // Resolve headers
    const headers = await this.resolveHeaders(
      endpointConfig,
      providerAccount
    )
    
    // Merge custom headers
    if (customHeaders) {
      Object.assign(headers, customHeaders)
    }
    
    return {
      url,
      method: method || 'GET',
      headers,
      timeoutMs: timeoutMs || 30000
    }
  }
  
  async buildRequest(
    endpoint: ResolvedEndpoint,
    input: NormalizedInput,
    authResult: AuthResult
  ): Promise<BuiltRequest> {
    // Add auth credentials to headers
    const headers = { ...endpoint.headers }
    
    if (authResult.credentials) {
      Object.assign(headers, authResult.credentials)
    }
    
    // Add request ID
    headers['X-Request-ID'] = generateUUID()
    
    // Build body/params from input
    const body = await this.buildRequestBody(endpoint, input)
    const query = await this.buildRequestQuery(endpoint, input)
    
    return {
      ...endpoint,
      headers,
      body,
      query,
      requestId: headers['X-Request-ID']
    }
  }
  
  async executeRequest(
    request: BuiltRequest,
    context: ExecutionContext
  ): Promise<RawResponse> {
    const startTime = Date.now()
    
    try {
      // Build fetch options
      const options: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.timeout(request.timeoutMs)
      }
      
      if (request.body && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
        options.body = JSON.stringify(request.body)
      }
      
      // Build URL with query params
      let url = request.url
      if (request.query && Object.keys(request.query).length > 0) {
        const params = new URLSearchParams(request.query)
        url += `?${params.toString()}`
      }
      
      // Execute request
      const response = await fetch(url, options)
      
      // Parse response
      const responseBody = await response.json()
      
      const rawResponse: RawResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        responseTime: Date.now() - startTime,
        requestId: context.requestId
      }
      
      // Check for HTTP errors
      if (!response.ok) {
        logger.warn('HTTP error response', {
          status: response.status,
          url: request.url,
          requestId: context.requestId
        })
      }
      
      return rawResponse
      
    } catch (error) {
      logger.error('Request execution failed', {
        url: request.url,
        error: error.message,
        requestId: context.requestId
      })
      
      throw error
    }
  }
  
  private resolveBaseUrl(providerAccount: ProviderAccount): string {
    // Use account-specific URL if provided
    if (providerAccount.endpoint) {
      return providerAccount.endpoint
    }
    
    // Use template base URL
    return this.template.baseUrl || ''
  }
  
  private resolvePath(
    path: string,
    providerAccount: ProviderAccount
  ): string {
    // Replace path variables like {partnerId}, {accountId}
    let resolved = path
    
    if (providerAccount.partnerId) {
      resolved = resolved.replace('{partnerId}', providerAccount.partnerId)
    }
    
    if (providerAccount.accountId) {
      resolved = resolved.replace('{accountId}', providerAccount.accountId)
    }
    
    return resolved
  }
  
  private async resolveHeaders(
    endpointConfig: any,
    providerAccount: ProviderAccount
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
    
    // Add template headers
    const templateHeaders = (this.template as any).headers || []
    for (const header of templateHeaders) {
      if (!header.operation || header.operation === endpointConfig.operation) {
        headers[header.key] = this.resolveHeaderValue(
          header.value,
          providerAccount
        )
      }
    }
    
    return headers
  }
  
  private resolveHeaderValue(
    value: string,
    providerAccount: ProviderAccount
  ): string {
    // Replace variables in header value
    return value
      .replace('{partnerId}', providerAccount.partnerId || '')
      .replace('{accountId}', providerAccount.accountId || '')
      .replace('{apiKey}', providerAccount.apiKey || '')
  }
  
  private async buildRequestBody(
    endpoint: ResolvedEndpoint,
    input: NormalizedInput
  ): Promise<any> {
    // Get request mapping for this operation
    const requestMappings = (this.template as any).requestMappings || []
    const operationMappings = requestMappings.filter(
      (m: any) => m.operation === input.operation
    )
    
    // Build body from input and mappings
    const body: Record<string, any> = {}
    
    for (const mapping of operationMappings) {
      const value = input[mapping.internalField]
      if (value !== undefined) {
        body[mapping.externalField] = this.applyTransform(
          value,
          mapping.transform
        )
      } else if (mapping.defaultValue) {
        body[mapping.externalField] = mapping.defaultValue
      } else if (mapping.isRequired) {
        throw new Error(`Required field ${mapping.internalField} is missing`)
      }
    }
    
    return body
  }
  
  private async buildRequestQuery(
    endpoint: ResolvedEndpoint,
    input: NormalizedInput
  ): Promise<Record<string, string>> {
    // Similar to buildRequestBody but for query params
    return {}
  }
  
  private applyTransform(value: any, transform?: any): any {
    if (!transform) return value
    
    // Apply transform based on type
    switch (transform.type) {
      case 'toUpperCase':
        return String(value).toUpperCase()
      case 'toLowerCase':
        return String(value).toLowerCase()
      case 'formatDate':
        return this.formatDate(value, transform.params?.format)
      case 'concat':
        return transform.params?.prefix + value + transform.params?.suffix
      case 'custom':
        // TODO: Implement custom transform evaluation
        return value
      default:
        return value
    }
  }
  
  private formatDate(value: any, format?: string): string {
    const date = new Date(value)
    if (isNaN(date.getTime())) return String(value)
    
    // Simple format implementation
    return date.toISOString()
  }
}
```

---

## 5. Thin Protocol Adapters

### 5.1 Adapter Interface

```typescript
// src/lib/providers/v2/adapters/protocol-adapter.ts

import { AuthConfig, AuthResult, ExecutionContext } from '../interfaces/dto'
import { ProviderAccount } from '@prisma/client'

export interface IProtocolAdapter {
  readonly name: string
  readonly protocolType: string
  
  // Authentication
  authenticate(
    config: AuthConfig,
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult>
  
  // Token refresh (if applicable)
  refreshToken?(
    config: AuthConfig,
    credentials: any,
    context: ExecutionContext
  ): Promise<AuthResult>
  
  // Request signing/modification
  signRequest?(
    request: any,
    credentials: any,
    context: ExecutionContext
  ): Promise<any>
  
  // Response parsing (if non-standard)
  parseResponse?(
    response: any,
    context: ExecutionContext
  ): Promise<any>
  
  // Validation
  validateCredentials?(
    config: AuthConfig,
    credentials: any
  ): Promise<boolean>
}

// OAuth Adapter
export interface IOAuthAdapter extends IProtocolAdapter {
  // OAuth 1.0
  getOAuth1Signature?(
    method: string,
    url: string,
    params: any,
    consumerSecret: string,
    tokenSecret?: string
  ): Promise<string>
  
  // OAuth 2.0
  getAccessToken?(
    config: AuthConfig,
    authorizationCode: string,
    context: ExecutionContext
  ): Promise<AuthResult>
  
  refreshAccessToken?(
    config: AuthConfig,
    refreshToken: string,
    context: ExecutionContext
  ): Promise<AuthResult>
}

// SOAP Adapter
export interface ISoapAdapter extends IProtocolAdapter {
  buildSoapEnvelope?(
    operation: string,
    params: any,
    config: AuthConfig
  ): Promise<string>
  
  parseSoapResponse?(
    response: string,
    operation: string
  ): Promise<any>
  
  generateSoapAuthHeader?(
    config: AuthConfig,
    providerAccount: ProviderAccount
  ): Promise<string>
}

// GraphQL Adapter
export interface IGraphQLAdapter extends IProtocolAdapter {
  buildQuery?(
    query: string,
    variables: any
  ): Promise<string>
  
  parseResponse?(
    response: any,
    fields: string[]
  ): Promise<any>
}

// HMAC Adapter
export interface IHMACAdapter extends IProtocolAdapter {
  generateSignature?(
    payload: string,
    secret: string,
    algorithm: string
  ): Promise<string>
  
  verifySignature?(
    payload: string,
    signature: string,
    secret: string,
    algorithm: string
  ): Promise<boolean>
}
```

### 5.2 Concrete Adapter Implementations

```typescript
// src/lib/providers/v2/adapters/oauth-adapter.ts

import { IOAuthAdapter } from './protocol-adapter'
import { AuthConfig, AuthResult, ExecutionContext } from '../interfaces/dto'
import { ProviderAccount } from '@prisma/client'
import crypto from 'crypto'
import { logger } from '@/lib/utils/logger'

export class OAuthAdapter implements IOAuthAdapter {
  readonly name = 'oauth'
  readonly protocolType = 'OAUTH'
  
  async authenticate(
    config: AuthConfig,
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    // Implementation depends on OAuth version
    throw new Error('Not implemented')
  }
  
  async refreshToken(
    config: AuthConfig,
    credentials: any,
    context: ExecutionContext
  ): Promise<AuthResult> {
    // Implementation depends on OAuth version
    throw new Error('Not implemented')
  }
  
  async getOAuth1Signature(
    method: string,
    url: string,
    params: any,
    consumerSecret: string,
    tokenSecret?: string
  ): Promise<string> {
    // OAuth 1.0 signature generation
    const baseString = this.generateBaseString(method, url, params)
    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret || '')}`
    
    return crypto
      .createHmac('sha1', signingKey)
      .update(baseString)
      .digest('base64')
  }
  
  private generateBaseString(
    method: string,
    url: string,
    params: any
  ): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&')
    
    return `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`
  }
}
```

```typescript
// src/lib/providers/v2/adapters/soap-adapter.ts

import { ISoapAdapter } from './protocol-adapter'
import { AuthConfig, AuthResult, ExecutionContext } from '../interfaces/dto'
import { ProviderAccount } from '@prisma/client'
import { logger } from '@/lib/utils/logger'

export class SoapAdapter implements ISoapAdapter {
  readonly name = 'soap'
  readonly protocolType = 'SOAP'
  
  async authenticate(
    config: AuthConfig,
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    // SOAP authentication typically done via WS-Security header
    const credentials = {
      username: providerAccount.credentials?.username,
      password: providerAccount.credentials?.password
    }
    
    return {
      success: true,
      credentials: {
        'WSSE': this.generateWSSecurityHeader(credentials)
      }
    }
  }
  
  async buildSoapEnvelope(
    operation: string,
    params: any,
    config: AuthConfig
  ): Promise<string> {
    const soapVersion = config.soapVersion || '1.1'
    const namespace = config.soapNamespace || 'http://tempuri.org/'
    
    let envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:ns="${namespace}">
  <soap:Header/>
  <soap:Body>
    <ns:${operation}>`
    
    // Add parameters
    for (const [key, value] of Object.entries(params)) {
      envelope += `
      <ns:${key}>${value}</ns:${key}>`
    }
    
    envelope += `
    </ns:${operation}>
  </soap:Body>
</soap:Envelope>`
    
    return envelope
  }
  
  async parseSoapResponse(
    response: string,
    operation: string
  ): Promise<any> {
    // Parse SOAP XML response
    // This is a simplified version - real implementation would use proper XML parsing
    const parser = new DOMParser()
    const doc = parser.parseFromString(response, 'text/xml')
    
    // Extract body content
    const body = doc.querySelector('soap\\:Body, Body')
    if (!body) {
      throw new Error('Invalid SOAP response: no body found')
    }
    
    // Parse operation result
    const result = body.querySelector(`ns\\:${operation}Result, ${operation}Result`)
    if (!result) {
      throw new Error(`Invalid SOAP response: no ${operation}Result found`)
    }
    
    return JSON.parse(result.textContent || '{}')
  }
  
  async generateSoapAuthHeader(
    config: AuthConfig,
    providerAccount: ProviderAccount
  ): Promise<string> {
    const username = providerAccount.credentials?.username
    const password = providerAccount.credentials?.password
    const nonce = crypto.randomBytes(16).toString('base64')
    const created = new Date().toISOString()
    
    // WS-Security UsernameToken
    const passwordDigest = crypto
      .createHash('sha1')
      .update(nonce + created + password)
      .digest('base64')
    
    return `
  <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
    <wsse:UsernameToken>
      <wsse:Username>${username}</wsse:Username>
      <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passwordDigest}</wsse:Password>
      <wsse:Nonce>${nonce}</wsse:Nonce>
      <wsse:Created>${created}</wsse:Created>
    </wsse:UsernameToken>
  </wsse:Security>`
  }
  
  private generateWSSecurityHeader(credentials: any): string {
    // Generate WS-Security header
    return ''
  }
}
```

```typescript
// src/lib/providers/v2/adapters/hmac-adapter.ts

import { IHMACAdapter } from './protocol-adapter'
import { AuthConfig, AuthResult, ExecutionContext } from '../interfaces/dto'
import { ProviderAccount } from '@prisma/client'
import crypto from 'crypto'
import { logger } from '@/lib/utils/logger'

export class HmacAdapter implements IHMACAdapter {
  readonly name = 'hmac'
  readonly protocolType = 'HMAC'
  
  async authenticate(
    config: AuthConfig,
    providerAccount: ProviderAccount,
    context: ExecutionContext
  ): Promise<AuthResult> {
    const secret = providerAccount.credentials?.hmacSecret || config.hmacSecret
    
    if (!secret) {
      throw new Error('HMAC secret not configured')
    }
    
    return {
      success: true,
      credentials: {
        hmacSecret: secret,
        hmacAlgorithm: config.hmacAlgorithm || 'sha256',
        hmacHeaders: config.hmacHeaders || ['date', 'content-md5']
      }
    }
  }
  
  async generateSignature(
    payload: string,
    secret: string,
    algorithm: string
  ): Promise<string> {
    return crypto
      .createHmac(algorithm, secret)
      .update(payload)
      .digest('base64')
  }
  
  async verifySignature(
    payload: string,
    signature: string,
    secret: string,
    algorithm: string
  ): Promise<boolean> {
    const expectedSignature = await this.generateSignature(
      payload,
      secret,
      algorithm
    )
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  }
  
  async signRequest(
    request: any,
    credentials: any,
    context: ExecutionContext
  ): Promise<any> {
    const { hmacSecret, hmacAlgorithm, hmacHeaders } = credentials
    
    // Build string to sign
    const stringToSign = this.buildStringToSign(request, hmacHeaders)
    
    // Generate signature
    const signature = await this.generateSignature(
      stringToSign,
      hmacSecret,
      hmacAlgorithm
    )
    
    // Add signature to request
    request.headers['Authorization'] = `MAC ${signature}`
    
    return request
  }
  
  private buildStringToSign(request: any, headers: string[]): string {
    const parts: string[] = []
    
    for (const header of headers) {
      switch (header.toLowerCase()) {
        case 'date':
          parts.push(request.headers?.date || new Date().toUTCString())
          break
        case 'content-md5':
          parts.push(request.headers?.['content-md5'] || '')
          break
        case 'content-type':
          parts.push(request.headers?.['content-type'] || '')
          break
        case 'request-line':
          parts.push(`${request.method} ${request.url} HTTP/1.1`)
          break
        default:
          parts.push(request.headers?.[header] || '')
      }
    }
    
    return parts.join('\n')
  }
}
```

---

## 6. Template Installer

### 6.1 Template Configuration Format

```typescript
// src/lib/providers/v2/template-installer/template-config.ts

export interface ProviderTemplateConfig {
  // Basic Info
  name: string
  displayName: string
  providerFamily: string
  description?: string
  
  // Capabilities
  supportedCapabilities: string[]
  capabilityMatrix?: Record<string, any>
  
  // Auth
  authStrategy: string
  authConfig: AuthConfig
  
  // Protocol
  protocolType: string
  protocolConfig?: ProtocolConfig
  
  // Base URLs
  baseUrl: string
  baseUrlDev?: string
  baseUrlStaging?: string
  
  // Endpoints
  endpoints: EndpointConfig[]
  
  // Headers
  headers: HeaderConfig[]
  
  // Request/Response Mappings
  requestMappings: FieldMapping[]
  responseMappings: FieldMapping[]
  
  // Webhooks
  webhooks?: WebhookConfig[]
  
  // Error Mapping
  errorMapping?: ErrorMappingConfig[]
  
  // Retry
  retryConfig?: RetryConfig
  
  // Rate Limiting
  rateLimitConfig?: RateLimitConfig
  
  // Health Check
  healthCheckConfig?: HealthCheckConfig
  
  // Sync Config
  syncConfig?: SyncConfig
}

export interface EndpointConfig {
  operation: string
  name: string
  method: string
  path: string
  fullPath?: string
  timeoutMs?: number
  requiresAuth?: boolean
  customHeaders?: Record<string, string>
  
  // Request
  requestBody?: any
  requestQuery?: any
  requestParams?: any
  
  // Response
  responseMapping: FieldMapping[]
  
  // Pagination
  pagination?: PaginationConfig
  
  // Error handling
  errorPaths?: string[]
}

export interface HeaderConfig {
  key: string
  value?: string
  isSecret?: boolean
  isDynamic?: boolean
  dynamicExpression?: string
  operation?: string
  priority?: number
}

// ... other config types
```

### 6.2 Template Installer Implementation

```typescript
// src/lib/providers/v2/template-installer/template-installer.ts

import { PrismaClient, ProviderTemplate } from '@prisma/client'
import { ProviderTemplateConfig } from './template-config'
import { TemplateValidator } from './template-validator'
import { logger } from '@/lib/utils/logger'

export class TemplateInstaller {
  private prisma: PrismaClient
  private validator: TemplateValidator
  
  constructor(prisma: PrismaClient) {
    this.prisma = prisma
    this.validator = new TemplateValidator()
  }
  
  async installTemplate(
    config: ProviderTemplateConfig
  ): Promise<ProviderTemplate> {
    // Validate config
    const validation = this.validator.validate(config)
    if (!validation.valid) {
      throw new Error(`Invalid template config: ${validation.errors?.join(', ')}`)
    }
    
    // Check if template already exists
    const existing = await this.prisma.providerTemplate.findUnique({
      where: { name: config.name }
    })
    
    if (existing) {
      // Update existing template
      return this.updateTemplate(existing.id, config)
    }
    
    // Create new template
    return this.createTemplate(config)
  }
  
  private async createTemplate(
    config: ProviderTemplateConfig
  ): Promise<ProviderTemplate> {
    const template = await this.prisma.providerTemplate.create({
      data: {
        name: config.name,
        displayName: config.displayName,
        providerFamily: config.providerFamily,
        description: config.description,
        supportedCapabilities: config.supportedCapabilities,
        capabilityMatrix: config.capabilityMatrix,
        authStrategy: config.authStrategy,
        authConfig: config.authConfig,
        protocolType: config.protocolType,
        protocolConfig: config.protocolConfig,
        baseUrl: config.baseUrl,
        baseUrlDev: config.baseUrlDev,
        baseUrlStaging: config.baseUrlStaging,
        isActive: true,
        isDefault: false,
        version: 1,
        
        // Create related records
        endpoints: {
          create: config.endpoints.map(ep => ({
            operation: ep.operation,
            name: ep.name,
            method: ep.method,
            path: ep.path,
            fullPath: ep.fullPath,
            timeoutMs: ep.timeoutMs,
            requiresAuth: ep.requiresAuth ?? true,
            customHeaders: ep.customHeaders,
            requestBody: ep.requestBody,
            requestQuery: ep.requestQuery,
            requestParams: ep.requestParams,
            responseMapping: ep.responseMapping,
            pagination: ep.pagination,
            errorPaths: ep.errorPaths
          }))
        },
        
        headers: {
          create: config.headers.map(h => ({
            key: h.key,
            value: h.value,
            isSecret: h.isSecret ?? false,
            isDynamic: h.isDynamic ?? false,
            dynamicExpression: h.dynamicExpression,
            operation: h.operation,
            priority: h.priority ?? 0
          }))
        },
        
        requestMappings: {
          create: config.requestMappings.map(m => ({
            operation: m.operation,
            internalField: m.internal,
            externalField: m.external,
            dataType: m.dataType,
            isRequired: m.required,
            defaultValue: m.defaultValue,
            transform: m.transform,
            validation: m.validation
          }))
        },
        
        responseMappings: {
          create: config.responseMappings.map(m => ({
            operation: m.operation,
            internalField: m.internal,
            externalPath: m.external,
            dataType: m.dataType,
            isRequired: m.required,
            defaultValue: m.defaultValue,
            transform: m.transform,
            nestedMapping: m.nestedMapping
          }))
        },
        
        // Webhooks
        webhooks: config.webhooks ? {
          create: config.webhooks.map(w => ({
            event: w.event,
            externalEvent: w.externalEvent,
            payloadMapping: w.payloadMapping,
            extractFields: w.extractFields,
            transformRules: w.transformRules,
            filterConditions: w.filterConditions,
            targetTable: w.targetTable,
            targetField: w.targetField
          }))
        } : undefined,
        
        // Error mapping
        errorMappings: config.errorMapping ? {
          create: config.errorMapping.map(e => ({
            providerCode: e.providerCode,
            internalCode: e.internalCode,
            messageTemplate: e.messageTemplate,
            retryable: e.retryable ?? false,
            category: e.category ?? 'UNKNOWN'
          }))
        } : undefined,
        
        // Retry config
        retryConfig: config.retryConfig,
        
        // Rate limit config
        rateLimitConfig: config.rateLimitConfig,
        
        // Health check config
        healthCheckConfig: config.healthCheckConfig,
        
        // Sync config
        syncConfig: config.syncConfig
      },
      include: {
        endpoints: true,
        headers: true,
        requestMappings: true,
        responseMappings: true,
        webhooks: true,
        errorMappings: true
      }
    })
    
    logger.info('Template installed', {
      templateId: template.id,
      name: template.name,
      providerFamily: template.providerFamily
    })
    
    return template
  }
  
  private async updateTemplate(
    templateId: string,
    config: ProviderTemplateConfig
  ): Promise<ProviderTemplate> {
    // Update template
    const template = await this.prisma.providerTemplate.update({
      where: { id: templateId },
      data: {
        displayName: config.displayName,
        description: config.description,
        supportedCapabilities: config.supportedCapabilities,
        capabilityMatrix: config.capabilityMatrix,
        authStrategy: config.authStrategy,
        authConfig: config.authConfig,
        protocolType: config.protocolType,
        protocolConfig: config.protocolConfig,
        baseUrl: config.baseUrl,
        baseUrlDev: config.baseUrlDev,
        baseUrlStaging: config.baseUrlStaging,
        version: { increment: 1 },
        
        // Delete and recreate related records
        endpoints: {
          deleteMany: {},
          create: config.endpoints.map(ep => ({
            operation: ep.operation,
            name: ep.name,
            method: ep.method,
            path: ep.path,
            fullPath: ep.fullPath,
            timeoutMs: ep.timeoutMs,
            requiresAuth: ep.requiresAuth ?? true,
            customHeaders: ep.customHeaders,
            requestBody: ep.requestBody,
            requestQuery: ep.requestQuery,
            requestParams: ep.requestParams,
            responseMapping: ep.responseMapping,
            pagination: ep.pagination,
            errorPaths: ep.paths
          }))
        },
        
        headers: {
          deleteMany: {},
          create: config.headers.map(h => ({
            key: h.key,
            value: h.value,
            isSecret: h.isSecret ?? false,
            isDynamic: h.isDynamic ?? false,
            dynamicExpression: h.dynamicExpression,
            operation: h.operation,
            priority: h.priority ?? 0
          }))
        },
        
        requestMappings: {
          deleteMany: {},
          create: config.requestMappings.map(m => ({
            operation: m.operation,
            internalField: m.internal,
            externalField: m.external,
            dataType: m.dataType,
            isRequired: m.required,
            defaultValue: m.defaultValue,
            transform: m.transform,
            validation: m.validation
          }))
        },
        
        responseMappings: {
          deleteMany: {},
          create: config.responseMappings.map(m => ({
            operation: m.operation,
            internalField: m.internal,
            externalPath: m.external,
            dataType: m.dataType,
            isRequired: m.required,
            defaultValue: m.defaultValue,
            transform: m.transform,
            nestedMapping: m.nestedMapping
          }))
        },
        
        // Webhooks
        webhooks: {
          deleteMany: {},
          create: config.webhooks?.map(w => ({
            event: w.event,
            externalEvent: w.externalEvent,
            payloadMapping: w.payloadMapping,
            extractFields: w.extractFields,
            transformRules: w.transformRules,
            filterConditions: w.filterConditions,
            targetTable: w.targetTable,
            targetField: w.targetField
          })) || []
        },
        
        // Error mapping
        errorMappings: {
          deleteMany: {},
          create: config.errorMapping?.map(e => ({
            providerCode: e.providerCode,
            internalCode: e.internalCode,
            messageTemplate: e.messageTemplate,
            retryable: e.retryable ?? false,
            category: e.category ?? 'UNKNOWN'
          })) || []
        },
        
        // Config
        retryConfig: config.retryConfig,
        rateLimitConfig: config.rateLimitConfig,
        healthCheckConfig: config.healthCheckConfig,
        syncConfig: config.syncConfig
      },
      include: {
        endpoints: true,
        headers: true,
        requestMappings: true,
        responseMappings: true,
        webhooks: true,
        errorMappings: true
      }
    })
    
    logger.info('Template updated', {
      templateId: template.id,
      name: template.name,
      version: template.version
    })
    
    return template
  }
  
  async uninstallTemplate(templateId: string): Promise<void> {
    // Check if template is in use
    const providersUsing = await this.prisma.provider.count({
      where: { providerTemplateId: templateId }
    })
    
    if (providersUsing > 0) {
      throw new Error(`Template is in use by ${providersUsing} providers`)
    }
    
    // Delete template
    await this.prisma.providerTemplate.delete({
      where: { id: templateId }
    })
    
    logger.info('Template uninstalled', { templateId })
  }
}
```

### 6.3 Template Validator

```typescript
// src/lib/providers/v2/template-installer/template-validator.ts

import { ProviderTemplateConfig } from './template-config'
import { ValidationResult, ValidationError } from '../interfaces/dto'

export class TemplateValidator {
  validate(config: ProviderTemplateConfig): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    
    // Basic validation
    if (!config.name) {
      errors.push({
        field: 'name',
        message: 'Template name is required',
        code: 'REQUIRED'
      })
    }
    
    if (!config.displayName) {
      errors.push({
        field: 'displayName',
        message: 'Display name is required',
        code: 'REQUIRED'
      })
    }
    
    if (!config.providerFamily) {
      errors.push({
        field: 'providerFamily',
        message: 'Provider family is required',
        code: 'REQUIRED'
      })
    }
    
    if (!config.authStrategy) {
      errors.push({
        field: 'authStrategy',
        message: 'Auth strategy is required',
        code: 'REQUIRED'
      })
    }
    
    if (!config.baseUrl) {
      errors.push({
        field: 'baseUrl',
        message: 'Base URL is required',
        code: 'REQUIRED'
      })
    }
    
    // Validate endpoints
    if (!config.endpoints || config.endpoints.length === 0) {
      errors.push({
        field: 'endpoints',
        message: 'At least one endpoint is required',
        code: 'REQUIRED'
      })
    } else {
      for (const endpoint of config.endpoints) {
        if (!endpoint.operation) {
          errors.push({
            field: 'endpoints.operation',
            message: 'Endpoint operation is required',
            code: 'REQUIRED'
          })
        }
        
        if (!endpoint.path) {
          errors.push({
            field: 'endpoints.path',
            message: 'Endpoint path is required',
            code: 'REQUIRED'
          })
        }
        
        if (!endpoint.responseMapping || endpoint.responseMapping.length === 0) {
          warnings.push({
            field: 'endpoints.responseMapping',
            message: 'Endpoint has no response mapping',
            code: 'MISSING_CONFIG'
          })
        }
      }
    }
    
    // Validate capabilities
    if (!config.supportedCapabilities || config.supportedCapabilities.length === 0) {
      warnings.push({
        field: 'supportedCapabilities',
        message: 'No capabilities defined',
        code: 'MISSING_CONFIG'
      })
    }
    
    // Validate auth config
    if (config.authStrategy !== 'NONE') {
      this.validateAuthConfig(config.authConfig, errors, warnings)
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    }
  }
  
  private validateAuthConfig(
    authConfig: any,
    errors: ValidationError[],
    warnings: ValidationError[]
  ): void {
    if (!authConfig) {
      errors.push({
        field: 'authConfig',
        message: 'Auth config is required for non-NONE strategy',
        code: 'REQUIRED'
      })
      return
    }
    
    switch (authConfig.strategy) {
      case 'OAUTH2':
        if (!authConfig.tokenUrl) {
          errors.push({
            field: 'authConfig.tokenUrl',
            message: 'Token URL is required for OAuth2',
            code: 'REQUIRED'
          })
        }
        if (!authConfig.clientId) {
          errors.push({
            field: 'authConfig.clientId',
            message: 'Client ID is required for OAuth2',
            code: 'REQUIRED'
          })
        }
        break
        
      case 'API_KEY':
        if (!authConfig.apiKeyHeader && !authConfig.apiKeyParam) {
          warnings.push({
            field: 'authConfig.apiKeyHeader',
            message: 'API key header/param not specified, defaulting to X-API-Key',
            code: 'DEFAULT_VALUE'
          })
        }
        break
        
      case 'HMAC':
        if (!authConfig.hmacAlgorithm) {
          warnings.push({
            field: 'authConfig.hmacAlgorithm',
            message: 'HMAC algorithm not specified, defaulting to sha256',
            code: 'DEFAULT_VALUE'
          })
        }
        break
    }
  }
}
```

---

## 7. Migration Strategy

### 7.1 Migration Steps

1. **Phase 1: Schema Enhancement**
   - Add new tables to schema.prisma
   - Create migration
   - Deploy to production

2. **Phase 2: Engine Implementation**
   - Implement all engine classes
   - Implement protocol adapters
   - Write unit tests

3. **Phase 3: Template Configuration**
   - Create template configs for existing providers (CHOICE, TELNA, AIRHUB, MOCK)
   - Install templates using TemplateInstaller
   - Verify templates work correctly

4. **Phase 4: Code Refactoring**
   - Update `isTemplateDrivenProvider()` to use new engine
   - Update connector factory to use new engine
   - Remove hardcoded branching
   - Update all provider-specific files

5. **Phase 5: Testing & Validation**
   - Run all existing tests
   - Add new tests for template-driven operations
   - Validate all providers work correctly

6. **Phase 6: Documentation & Training**
   - Document new architecture
   - Create provider template creation guide
   - Train team on new system

### 7.2 Backwards Compatibility

- **Provider Model**: Existing `Provider` model remains unchanged
- **ProviderAccount**: Existing `ProviderAccount` model remains unchanged
- **Existing Connectors**: Can be kept as fallback during migration
- **API Endpoints**: All existing API endpoints continue to work
- **Database**: No breaking changes to existing tables

### 7.3 Rollback Strategy

- Keep old code paths available until new system is fully validated
- Feature flag to switch between old and new system
- Ability to revert to old system if issues arise

---

## 8. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Schema design and migration
- [ ] Core engine interfaces
- [ ] Normalized DTOs
- [ ] Basic provider engine implementation

### Phase 2: Engines (Week 3-4)
- [ ] Authentication engine
- [ ] Endpoint engine
- [ ] Request builder
- [ ] Response mapper
- [ ] Capability engine

### Phase 3: Adapters (Week 5-6)
- [ ] OAuth adapter
- [ ] SOAP adapter
- [ ] HMAC adapter
- [ ] GraphQL adapter
- [ ] Protocol adapter base

### Phase 4: Template System (Week 7-8)
- [ ] Template installer
- [ ] Template validator
- [ ] Template migrator
- [ ] Template configs for existing providers

### Phase 5: Integration (Week 9-10)
- [ ] Update adapter manager
- [ ] Update connector factory
- [ ] Remove hardcoded branching
- [ ] Update all provider-specific files

### Phase 6: Testing & Documentation (Week 11-12)
- [ ] Unit tests
- [ ] Integration tests
- [ ] Documentation
- [ ] Training

---

## 9. Success Metrics

- **Code Reduction**: Remove 500+ lines of provider-specific branching
- **New Provider Time**: Add new provider in < 1 hour (vs days currently)
- **Test Coverage**: 90%+ coverage for new code
- **Performance**: No degradation in API response times
- **Reliability**: 99.9% uptime for all providers

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing providers | High | Feature flag, gradual rollout, comprehensive testing |
| Performance degradation | Medium | Load testing, caching, optimization |
| Complexity increase | Medium | Clear documentation, modular design, good abstractions |
| Template validation errors | Low | Comprehensive validation, clear error messages |
| Migration issues | Medium | Rollback strategy, parallel running, careful testing |

---

## 11. Appendix

### A. Template Expression Language

Template expressions allow dynamic value computation:

```
// Variable substitution
{partnerId}
{accountId}
{apiKey}

// Transform functions
toUpperCase(value)
toLowerCase(value)
formatDate(value, "YYYY-MM-DD")
concat(prefix, value, suffix)
split(value, delimiter, index)
replace(value, pattern, replacement)
default(value, defaultValue)

// Custom expressions
custom:expression(value)
```

### B. Response Mapping Syntax

Response mapping uses JSONPath-like syntax:

```
// Simple path
$.data.planId

// Array access
$.data.plans[0].id

// Nested objects
$.data.response.order.orderId

// Conditional
$.data.status == "active" ? "ACTIVE" : "INACTIVE"

// Default value
$.data.price ?? 0
```

### C. Error Mapping Categories

- **AUTH**: Authentication/authorization errors
- **VALIDATION**: Input validation errors
- **NOT_FOUND**: Resource not found errors
- **RATE_LIMIT**: Rate limiting errors
- **SERVER**: Server-side errors
- **NETWORK**: Network/timeout errors
- **UNKNOWN**: Unclassified errors

---

**Document Version**: 1.0
**Last Updated**: 2026-07-24
**Author**: AI Assistant
**Status**: Draft - Pending Review
