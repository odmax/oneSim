# Phase P2C — Telna SeamlessOS Migration Architecture

> **Status:** Design Complete  
> **Date:** 2026-07-26  
> **Author:** Architecture Review  
> **Scope:** New `TelnaSeamlessConnector` using official SeamlessOS API  
> **Constraint:** Legacy `TelnaConnector` remains untouched and available

---

## Table of Contents

1. [SeamlessOS Architecture](#1-seamlessos-architecture)
2. [Legacy Coexistence Strategy](#2-legacy-coexistence-strategy)
3. [Confirmed Endpoint Contracts](#3-confirmed-endpoint-contracts)
4. [Connector Method Mapping](#4-connector-method-mapping)
5. [Full Activation Sequence](#5-full-activation-sequence)
6. [Identifier Persistence Mapping](#6-identifier-persistence-mapping)
7. [Status Normalization Table](#7-status-normalization-table)
8. [Error and Wallet Action Matrix](#8-error-and-wallet-action-matrix)
9. [Idempotency Design](#9-idempotency-design)
10. [Pending and Reconciliation Design](#10-pending-and-reconciliation-design)
11. [Provider Framework V2 Integration](#11-provider-framework-v2-integration)
12. [Required Code Changes by File](#12-required-code-changes-by-file)
13. [Schema Impact](#13-schema-impact)
14. [Test Plan](#14-test-plan)
15. [Deployment and Rollback Plan](#15-deployment-and-rollback-plan)
16. [Risks and Open Questions](#16-risks-and-open-questions)

---

## 1. SeamlessOS Architecture

### 1.1 Platform Overview

SeamlessOS (formerly Telna) is a fully automated BSS/OSS platform for mobile operators. The API is order-centric: every eSIM activation flows through an Order → Line Item → Subscription → eSIM QR lifecycle.

### 1.2 Architectural Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        OneSim Africa                            │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │ Client Portal │───>│  createOrder()   │───>│ provider-     │ │
│  └──────────────┘    │  provider-       │    │ purchase.ts   │ │
│                      │  purchase.ts     │    └──────┬────────┘ │
│                      └──────────────────┘           │          │
│                                                     │          │
│                    ┌────────────────────────────────┘          │
│                    │                                            │
│         ┌──────────┴──────────┐                                │
│         │                     │                                │
│         ▼                     ▼                                │
│  ┌─────────────┐     ┌──────────────────┐                     │
│  │ TelnaLegacy │     │ TelnaSeamless    │                     │
│  │ Connector   │     │ Connector (NEW)  │                     │
│  └─────────────┘     └────────┬─────────┘                     │
│                               │                                │
│                    ┌──────────┴──────────┐                    │
│                    │  SeamlessOS API      │                    │
│                    │  POST /orders        │                    │
│                    │  POST /orders/submit │                    │
│                    │  GET /subscriptions  │                    │
│                    │  GET /esim/qrcode    │                    │
│                    └─────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 SeamlessOS Lifecycle for OneSim

```
1. Browse product offerings        GET  /product-offerings
2. Create draft order              POST /orders
3. Add subscription line item      POST /orders/{id}/line-items
4. Add data package line item      POST /orders/{id}/line-items
5. Calculate price                 POST /orders/{id}/calculate-price
6. Submit order (externalPayment)  POST /orders/{id}/submit
7. Poll order until COMPLETED      GET  /orders/{id}
8. Retrieve subscription           GET  /subscriptions/{id}
9. Retrieve eSIM QR code           GET  /subscriptions/{id}/esim/qrcode
10. Create local eSIM record       [internal]
11. Capture wallet funds           [internal]
```

### 1.4 Two Telna Strategies

| Strategy | Connector | Use Case | Status |
|----------|-----------|----------|--------|
| `TELNA_LEGACY` | `TelnaConnector` | Manage existing SIMs, PCR profiles, usage, discovery | Preserved, no changes |
| `TELNA_SEAMLESS` | `TelnaSeamlessConnector` | New purchases, activation, status, QR, top-up | **NEW — this design** |

---

## 2. Legacy Coexistence Strategy

### 2.1 Principles

- The existing `TelnaConnector` (468 lines, 21 methods, 120+ tests) is **never modified**.
- No `if (strategy === 'TELNA_SEAMLESS')` branches are added to the legacy connector.
- The new `TelnaSeamlessConnector` is a **separate class** in a **separate file** with **separate endpoint definitions**.
- Both connectors share the `IProviderConnector` interface contract.
- Provider records determine which connector is used via the `adapterStrategy` field.

### 2.2 Strategy Resolution

```
provider.adapterStrategy === 'TELNA'         → TelnaConnector (legacy)
provider.adapterStrategy === 'TELNA_SEAMLESS' → TelnaSeamlessConnector (new)
```

The `connector-factory.ts` `resolveConnectorType()` function will map `'TELNA_SEAMLESS'` to a new connector type.

### 2.3 Capability Differences

| Capability | Legacy Telna | SeamlessOS |
|------------|-------------|------------|
| AUTH | ✅ (KeyID, no-op) | ✅ (X-API-Key) |
| CATALOG_SYNC | ❌ (not implemented) | ✅ (product-offerings) |
| PURCHASE | ❌ (NOT_IMPLEMENTED) | ✅ (order → subscription → QR) |
| STATUS | ❌ (NOT_IMPLEMENTED) | ✅ (GET /subscriptions/{id}) |
| USAGE | ✅ (getSimUsage) | ✅ (GET /subscriptions/{id}/usage) |
| TOP_UP | ❌ (NOT_IMPLEMENTED) | ✅ (POST /orders with addon line item) |
| SUSPEND | ❌ (NOT_IMPLEMENTED) | ✅ (POST /subscriptions/{id}/suspend) |
| RESUME | ❌ (NOT_IMPLEMENTED) | ✅ (POST /subscriptions/{id}/restore) |
| WEBHOOKS | ⚠️ (hardcoded ack) | ✅ (order.statusChanged, subscription.activated) |
| SMS_MT | ❌ (NOT_IMPLEMENTED) | SEAMLESSOS DOCUMENTATION REQUIRED |
| SMS_MO | ❌ (NOT_IMPLEMENTED) | SEAMLESSOS DOCUMENTATION REQUIRED |
| WALLET | ✅ (getWallet) | ❌ (not in SeamlessOS API) |
| INVENTORY | ✅ (listSimRegistries) | ⚠️ (GET /inventory/sims/{iccid} only) |
| PCR_PROFILE | ✅ (getSimPCRProfile) | ❌ (SeamlessOS-managed) |

### 2.4 Runtime Routing

When a customer purchases an eSIM for a Telna provider:

1. `selectProvider()` in `provider-purchase.ts` loads the provider record.
2. `getAdapterForType()` in `adapter-manager.ts` checks `adapterStrategy`.
3. If `TELNA_SEAMLESS`, builds `TelnaSeamlessConnector` → wraps via `connectorToAdapter()`.
4. If `TELNA` (legacy), builds `TelnaConnector` → wraps via `connectorToAdapter()`.

**No changes to `provider-purchase.ts` or `adapter-manager.ts` routing logic are needed** beyond adding the new connector type to the factory.

---

## 3. Confirmed Endpoint Contracts

All endpoints below are confirmed from the official SeamlessOS API reference at `docs.telnesstech.com`.

### 3.1 API Base URL

```
SEAMLESSOS_BASE_URL  — configured per environment (staging/production)
```

SEAMLESSOS DOCUMENTATION REQUIRED: The exact base URL hostname is not documented in the public API reference. It must be obtained from SeamlessOS account setup or portal settings.

### 3.2 Authentication

| Header | Value | Required |
|--------|-------|----------|
| `X-API-Key` | `<api-key>` | **Always** |
| `Authorization` | `Bearer <jwt-token>` | Optional (user-scoped operations) |

The API key is stored in the provider's `apiToken` field (encrypted). For system-level operations (our use case), only `X-API-Key` is needed. No OAuth flow is required.

### 3.3 Content Headers

```
Content-Type: application/json
Accept: application/json
X-Idempotency-Key: <uuid>  (for POST mutations)
```

### 3.4 Product Offerings

**List offerings:**
```
GET /product-offerings?customerType=CONSUMER&types=SUBSCRIPTION
```

**Response:**
```json
{
  "items": [
    {
      "productOfferingId": "uuid",
      "status": "AVAILABLE",
      "name": "Seamless 10GB",
      "description": "...",
      "customerType": "CONSUMER",
      "product": {
        "productId": "uuid",
        "internalName": "seamless_cell_10gb_us",
        "type": "SUBSCRIPTION",
        "category": "PRODUCT_CATEGORY_SUBSCRIPTION_CELL",
        "networkProviderId": "tmobile-us",
        "features": {
          "dataMb": 10240,
          "includedCallSeconds": 3600,
          "includedSms": 500
        }
      },
      "price": {
        "netPrice": 30,
        "currency": "USD",
        "priceType": "RECURRING",
        "billingCycle": { "period": "MONTHLY", "interval": 1 }
      }
    }
  ],
  "pagination": { "nextCursor": null }
}
```

**Get single offering:**
```
GET /product-offerings/{productOfferingId}
```

**Travel eSIM offerings:**
```
GET /product-offerings?categories=TRAVEL_ESIM_PACKAGE&countries=ES
GET /product-offerings?categories=TRAVEL_ESIM_PACKAGE&regions=EUROPE
```

### 3.5 Orders

**Create draft order:**
```
POST /orders
```

**Request body:**
```json
{
  "customerType": "CONSUMER",
  "customer": {
    "name": "Jane Smith",
    "customerType": "CONSUMER",
    "referenceId": "crm-cust-84321",
    "contact": {
      "email": "jane@example.com"
    }
  },
  "user": {
    "name": "Jane Smith",
    "email": "jane@example.com"
  },
  "lineItems": [
    {
      "type": "SUBSCRIPTION",
      "lineItemId": "line-1",
      "productOfferingId": "3f2504e0-...",
      "subscriber": {
        "name": "Jane Smith",
        "email": "jane@example.com"
      },
      "sim": {
        "esim": true
      }
    }
  ]
}
```

**Response:**
```json
{
  "orderId": "uuid",
  "state": "PENDING",
  "customer": { "customerId": "uuid", "newCustomer": true },
  "lineItems": [{ "lineItemId": "line-1", "status": "PENDING", ... }],
  "validation": { "isValid": true },
  "createdAt": "ISO8601",
  "expiresAt": "ISO8601"
}
```

**Add line item (if not included in create):**
```
POST /orders/{orderId}/line-items
```

**Submit order:**
```
POST /orders/{orderId}/submit
```

**Request body (external payment for wallet-based):**
```json
{
  "externalPayment": {
    "reference": "wallet-reserve-123",
    "receiptDescription": "OneSim eSIM purchase"
  }
}
```

**Response:**
```json
{
  "orderId": "uuid",
  "state": "SUBMITTED",
  "submittedAt": "ISO8601"
}
```

**Get order:**
```
GET /orders/{orderId}
```

**Response (completed):**
```json
{
  "orderId": "uuid",
  "state": "COMPLETED",
  "lineItems": [{ "lineItemId": "line-1", "status": "COMPLETED" }],
  "createdEntities": {
    "subscriptions": [
      {
        "subscriptionId": "uuid",
        "status": "ACTIVATED",
        "msisdn": "+14155550111",
        "createdByLineItem": "line-1"
      }
    ]
  },
  "completedAt": "ISO8601"
}
```

**Order states:**
`PENDING` → `PENDING_PAYMENT` → `SUBMITTED` → `PENDING_APPROVAL` → `PROCESSING` → `COMPLETED`
Also: `CANCELLED`, `EXPIRED`, `FAILED`

**Cancel order:**
```
POST /orders/{orderId}/cancel
```

### 3.6 Subscriptions

**Get subscription:**
```
GET /subscriptions/{subscriptionId}
```

SEAMLESSOS DOCUMENTATION REQUIRED: The exact response shape for `GET /subscriptions/{subscriptionId}` is not fully documented. Based on the Travel eSIM guide, it includes at minimum: `subscriptionId`, `status`, `msisdn`, and `subscriber`. The ICCID field name is not confirmed — it may be `iccid`, `icc`, or nested under a `sim` object.

**Activate subscription:**
```
POST /subscriptions/{subscriptionId}/activate
```

**Suspend subscription:**
```
POST /subscriptions/{subscriptionId}/suspend
```

**Resume subscription:**
```
POST /subscriptions/{subscriptionId}/restore
```

**Cancel subscription:**
```
POST /subscriptions/{subscriptionId}/cancel
```

### 3.7 eSIM QR Code

**Get QR code:**
```
GET /subscriptions/{subscriptionId}/esim/qrcode
```

SEAMLESSOS DOCUMENTATION REQUIRED: The exact response shape for the QR code endpoint is not documented. It likely returns one or more of: `qrCodeUrl`, `activationCode`, `smdpAddress`, `matchingId`, `lpa`. The exact field names must be confirmed from a live API response.

### 3.8 Inventory

**Get SIM by ICCID:**
```
GET /inventory/sims/{iccid}
```

**Lease phone numbers:**
```
POST /inventory/lease-numbers
```

### 3.9 Usage

**Get subscription usage:**
```
GET /subscriptions/{subscriptionId}/usage
```

SEAMLESSOS DOCUMENTATION REQUIRED: The exact response shape for usage data is not documented. Expected fields include data used, remaining, and total — but field names and structure are unknown.

### 3.10 Pagination

SeamlessOS uses **cursor-based pagination**:

```json
{
  "items": [...],
  "pagination": {
    "nextCursor": "abc123" | null
  }
}
```

Request parameter: `?cursor=<nextCursor>&limit=<pageSize>`

### 3.11 Error Response Structure

```json
{
  "message": "Validation failed for the request",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "message": "Email address is required",
      "code": "FIELD_REQUIRED",
      "property": "email",
      "suggestion": "Provide a valid email address"
    }
  ],
  "hint": "Ensure all required fields are provided"
}
```

### 3.12 HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Process response |
| 201 | Created | Process response |
| 400 | Bad Request / Validation | Check `details` for field errors |
| 401 | Unauthorized | Refresh API key |
| 403 | Forbidden | Check permissions |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate idempotency key or state conflict |
| 412 | Precondition Failed | Submission preconditions not met |
| 429 | Rate Limited | Retry with backoff |
| 500 | Server Error | Retry with exponential backoff |

---

## 4. Connector Method Mapping

| IProviderConnector Method | SeamlessOS Support | Implementation Strategy |
|--------------------------|-------------------|------------------------|
| `testConnection()` | **Directly supported** | `GET /product-offerings?limit=1` — verify API key works |
| `authenticate()` | **Unsupported** | Returns `{ success: false }` — API key is static, no OAuth |
| `getTokenState()` | **Directly supported** | Read from provider config — API keys don't expire |
| `ensureAuthenticated()` | **Directly supported** | Check API key exists, return success |
| `refreshAuthentication()` | **Unsupported** | Returns `false` — API keys don't expire |
| `syncPlans()` | **Directly supported** | `GET /product-offerings` with cursor pagination, map to `ConnectorPlan[]` |
| `activateESIM()` | **Multi-step supported** | Order create → line item → submit → poll → subscription → QR |
| `getStatus()` | **Directly supported** | `GET /subscriptions/{subscriptionId}` → normalize status |
| `getQRCode()` | **Directly supported** | `GET /subscriptions/{subscriptionId}/esim/qrcode` |
| `getUsage()` | **Directly supported** | `GET /subscriptions/{subscriptionId}/usage` |
| `topUpESIM()` | **Multi-step supported** | Create new order with ADDON line item referencing existing subscription |
| `suspendESIM()` | **Directly supported** | `POST /subscriptions/{subscriptionId}/suspend` |
| `resumeESIM()` | **Directly supported** | `POST /subscriptions/{subscriptionId}/restore` |
| `getRates()` | **Unsupported** | No rate/plan comparison endpoint in SeamlessOS |
| `diagnoseConnection()` | **Directly supported** | Same as `testConnection()` with extended diagnostics |

### 4.1 Capability Declarations

```typescript
// For TELNA_SEAMLESS provider type
TELNA_SEAMLESS: [
  'AUTH',
  'CATALOG_SYNC',
  'PURCHASE',
  'STATUS',
  'USAGE',
  'TOP_UP',
  'SUSPEND',
  'RESUME',
]
```

**Not declared** (no backing endpoints): SMS_MT, SMS_MO, WEBHOOKS (no webhook receiver in our system), WALLET (SeamlessOS has no wallet API — we handle wallet internally), INVENTORY (limited to SIM lookup, not full inventory management), PCR_PROFILE (SeamlessOS-managed internally).

---

## 5. Full Activation Sequence

### 5.1 activateESIM() — Multi-Step Flow

```
Step 1: Resolve product offering
   Input: params.planId (our package SKU or SeamlessOS productOfferingId)
   Action: If planId is our internal ID, look up providerPlanId from package record
           If planId is already a SeamlessOS productOfferingId, use directly
   Endpoint: GET /product-offerings/{productOfferingId} (validate existence)

Step 2: Create draft order
   Endpoint: POST /orders
   Body:
   {
     "customerType": "CONSUMER",
     "customer": {
       "name": "<subscriber.first_name> <subscriber.last_name>",
       "customerType": "CONSUMER",
       "referenceId": "<externalId || orderId>",
       "contact": { "email": "<subscriber.email>" }
     },
     "user": {
       "name": "<subscriber.first_name> <subscriber.last_name>",
       "email": "<subscriber.email>"
     },
     "lineItems": [
       {
         "type": "SUBSCRIPTION",
         "lineItemId": "line-1",
         "productOfferingId": "<resolved productOfferingId>",
         "subscriber": {
           "name": "<subscriber.first_name> <subscriber.last_name>",
           "email": "<subscriber.email>"
         },
         "sim": { "esim": true }
       }
     ]
   }
   Headers: { "X-Idempotency-Key": "<deterministic-key-from-providerPurchaseKey>" }
   Persist: seamlessOrderId from response.orderId

Step 3: Submit order
   Endpoint: POST /orders/{seamlessOrderId}/submit
   Body:
   {
     "externalPayment": {
       "reference": "<providerPurchaseKey>",
       "receiptDescription": "OneSim eSIM activation"
     }
   }
   Headers: { "X-Idempotency-Key": "<same-deterministic-key>" }
   Persist: order state = SUBMITTED

Step 4: Poll order until COMPLETED
   Endpoint: GET /orders/{seamlessOrderId}
   Interval: 2s, 4s, 8s, 16s (exponential backoff)
   Timeout: 120 seconds
   Stop conditions:
     - state === "COMPLETED" → proceed to Step 5
     - state === "FAILED" → terminal failure, release wallet
     - state === "CANCELLED" → terminal, release wallet
     - state === "EXPIRED" → terminal, release wallet
     - timeout exceeded → mark PENDING_PROVIDER, schedule retry

Step 5: Extract subscription ID
   Source: response.createdEntities.subscriptions[0].subscriptionId
   Persist: providerActivationId = subscriptionId

Step 6: Retrieve subscription (get ICCID)
   Endpoint: GET /subscriptions/{subscriptionId}
   Persist: iccid from response
   SEAMLESSOS DOCUMENTATION REQUIRED: Confirm ICCID field name in response

Step 7: Retrieve eSIM QR code
   Endpoint: GET /subscriptions/{subscriptionId}/esim/qrcode
   Persist: qrCodeUrl, smdpAddress, matchingId from response
   SEAMLESSOS DOCUMENTATION REQUIRED: Confirm QR response fields

Step 8: Build ActivateESIMResult
   Return: {
     activationId: subscriptionId,
     iccids: [iccid],
     qrCodeUrl: qrCodeUrl,
     matchingId: matchingId,
     smdpAddress: smdpAddress,
     status: normalizeStatus(subscription.status)
   }
```

### 5.2 Synchronous vs Asynchronous Handling

**Synchronous path** (fast provisioning, < 30s):
- Steps 2-7 complete within the HTTP request timeout
- Return full `ActivateESIMResult` with ICCID and QR

**Asynchronous path** (slow provisioning, > 30s):
- Step 4 polling times out (order still PROCESSING)
- Return partial result: `{ activationId: seamlessOrderId, iccids: [], status: 'PENDING' }`
- The `batchSyncPendingEsims()` job will re-poll and complete the activation
- Status sync calls `getStatus()` which polls `GET /subscriptions/{id}`

### 5.3 Error Rollback

If any step fails after wallet reservation:
1. Attempt `POST /orders/{orderId}/cancel` (only works in PENDING state)
2. Release wallet funds via `releaseReservedFunds()`
3. Transition order to FAILED
4. Log structured correlation event

---

## 6. Identifier Persistence Mapping

### 6.1 Identifier Table

| Identifier | Source | Storage Field | Notes |
|-----------|--------|---------------|-------|
| OneSim Order ID | Generated by us | `eSIMPurchase.id` | Internal UUID |
| SeamlessOS Order ID | `POST /orders` response | `eSIMPurchase.providerReservationId` | Used for polling and status |
| SeamlessOS Line Item ID | `POST /orders` response | `eSIMPurchase.config.seamlessLineItemId` | Stored in JSON config |
| SeamlessOS Subscription ID | `createdEntities.subscriptions[0].subscriptionId` | `eSIMPurchase.providerActivationId` | Used for status, QR, usage |
| SeamlessOS Product Offering ID | Input from package config | `Package.providerPlanId` | Maps to our package SKU |
| ICCID | `GET /subscriptions/{id}` response | `eSIM.iccid` | Primary SIM identifier |
| QR Code Reference | `GET /subscriptions/{id}/esim/qrcode` response | `eSIM.qrCodeUrl` | Activation QR data |

### 6.2 Field Assessment

| Existing Field | Sufficient? | Notes |
|---------------|-------------|-------|
| `providerReservationId` | ✅ Yes | Store SeamlessOS order ID |
| `providerFulfillId` | ✅ Yes | Store SeamlessOS subscription ID (alternative to providerActivationId) |
| `providerActivationId` | ✅ Yes | Store SeamlessOS subscription ID — used by `syncESIMStatus()` |
| `providerPurchaseKey` | ✅ Yes | Store deterministic idempotency key — used for retry safety |
| `providerStatus` | ✅ Yes | Store SeamlessOS order/subscription state |

### 6.3 No Schema Migration Required

All existing `eSIMPurchase` and `eSIM` fields are sufficient. The SeamlessOS order ID and subscription ID fit into existing provider reference fields. No new columns needed.

The `eSIMPurchase.config` JSON field will store:
```json
{
  "seamlessOrderId": "uuid",
  "seamlessLineItemId": "line-1",
  "seamlessSubscriptionId": "uuid",
  "strategy": "TELNA_SEAMLESS"
}
```

---

## 7. Status Normalization Table

### 7.1 Order State → Internal Status

| SeamlessOS Order State | Internal Order Status | Internal eSIM Status | Action |
|------------------------|----------------------|---------------------|--------|
| `PENDING` | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | Continue polling |
| `PENDING_PAYMENT` | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | Continue polling |
| `SUBMITTED` | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | Continue polling |
| `PENDING_APPROVAL` | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | Continue polling |
| `PROCESSING` | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | Continue polling |
| `COMPLETED` | `FULFILLED` | `PENDING_ACTIVATION` | Extract subscription, get QR |
| `CANCELLED` | `FAILED` | N/A | Release wallet |
| `EXPIRED` | `FAILED` | N/A | Release wallet |
| `FAILED` | `FAILED` | N/A | Release wallet |

### 7.2 Subscription State → Internal eSIM Status

| SeamlessOS Subscription State | Internal eSIM Status | Notes |
|------------------------------|---------------------|-------|
| `PENDING` | `PENDING_ACTIVATION` | Subscription created, not yet active |
| `ACTIVE` | `ACTIVE` | eSIM provisioned and ready |
| `CANCELLED` | `INACTIVE` | Subscription terminated |

### 7.3 Mapping Function

```typescript
function mapSeamlessOrderState(orderState: string): string {
  switch (orderState) {
    case 'PENDING':
    case 'PENDING_PAYMENT':
    case 'SUBMITTED':
    case 'PENDING_APPROVAL':
    case 'PROCESSING':
      return 'PENDING_PROVIDER'
    case 'COMPLETED':
      return 'FULFILLED'
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
      return 'FAILED'
    default:
      return 'PENDING_PROVIDER'
  }
}

function mapSeamlessSubscriptionState(subState: string): string {
  switch (subState) {
    case 'PENDING':
      return 'PENDING_ACTIVATION'
    case 'ACTIVE':
      return 'ACTIVE'
    case 'CANCELLED':
      return 'INACTIVE'
    default:
      return 'PENDING_ACTIVATION'
  }
}
```

---

## 8. Error and Wallet Action Matrix

### 8.1 Complete Error Matrix

| Error Condition | HTTP Code | Provider Error Code | Normalized Code | Retryable | Wallet Action | Order State | Reconciliation |
|----------------|-----------|-------------------|----------------|-----------|---------------|-------------|----------------|
| Missing API key | N/A | N/A | `AUTH_MISSING` | No | HOLD | FAILED | None — config error |
| 401 Unauthorized | 401 | N/A | `AUTH_FAILURE` | No | HOLD | FAILED | Check API key validity |
| 403 Forbidden | 403 | N/A | `AUTH_FORBIDDEN` | No | HOLD | FAILED | Check permissions |
| Invalid product offering | 400 | `VALIDATION_ERROR` | `INVALID_OFFERING` | No | RELEASE | FAILED | Map offering IDs |
| Unavailable inventory | 400/404 | N/A | `INVENTORY_UNAVAILABLE` | No | RELEASE | FAILED | Check stock |
| Invalid order (bad request) | 400 | `failed_precondition` | `INVALID_ORDER` | No | RELEASE | FAILED | Fix request shape |
| Order submission rejected | 412 | `missing_payment_session` | `SUBMISSION_REJECTED` | No | RELEASE | FAILED | Check payment config |
| Duplicate idempotency key (same data) | 409 | `idempotency_key_locked` | `DUPLICATE_REQUEST` | Yes (retry after 200ms) | HOLD | PENDING_PROVIDER | Re-fetch order |
| Duplicate idempotency key (different data) | 409 | `idempotency_key_mismatch` | `IDEMPOTENCY_CONFLICT` | No | RELEASE | FAILED | Programming error |
| Rate limited | 429 | N/A | `RATE_LIMITED` | Yes (exponential backoff) | HOLD | PENDING_PROVIDER | None |
| Request timeout | — | — | `TIMEOUT` | Yes (1 retry) | HOLD | PENDING_PROVIDER | Re-fetch order |
| Network failure | — | — | `NETWORK_ERROR` | Yes (exponential backoff) | HOLD | PENDING_PROVIDER | None |
| Provider 5xx | 500+ | N/A | `PROVIDER_UNAVAILABLE` | Yes (exponential backoff, max 3) | HOLD | PENDING_PROVIDER | Reconcile order |
| Malformed response | — | — | `PARSE_ERROR` | No | RELEASE | FAILED | Log and alert |
| Subscription pending | 200 | — | `PENDING` | N/A | HOLD | PENDING_PROVIDER | Continue polling |
| QR not ready | 200 | — | `QR_NOT_READY` | Yes (retry after 5s) | HOLD | PENDING_PROVIDER | Poll subscription |
| Terminal provider rejection | 200 | `FAILED` | `TERMINAL_FAILURE` | No | RELEASE | FAILED | None |

### 8.2 Wallet Action Definitions

| Action | Behavior |
|--------|----------|
| `HOLD` | Funds remain reserved — order is still in progress. `batchSyncPendingEsims()` will eventually resolve. |
| `RELEASE` | Call `releaseReservedFunds()` to return funds to wallet. Order transitions to FAILED. |
| `CAPTURE` | Call `captureReservedFunds()` to finalize the charge. Order transitions to FULFILLED. |
| `NONE` | No wallet interaction (e.g., status-only query). |

### 8.3 Structured Logging

All errors logged with:
```json
{
  "event": "SEAMLESS_ACTIVATION_ERROR",
  "providerCode": "TELNA_SEAMLESS",
  "orderId": "...",
  "seamlessOrderId": "...",
  "step": "ORDER_CREATE|ORDER_SUBMIT|ORDER_POLL|SUBSCRIPTION_RETRIEVE|QR_RETRIEVE",
  "httpStatus": 400,
  "providerCode": "VALIDATION_ERROR",
  "normalizedCode": "INVALID_OFFERING",
  "retryable": false,
  "latencyMs": 1234,
  "correlationId": "..."
}
```

---

## 9. Idempotency Design

### 9.1 SeamlessOS Idempotency Support

| Feature | Supported | Details |
|---------|-----------|---------|
| `X-Idempotency-Key` header | ✅ Yes | 24-hour expiry, client-generated UUID |
| External order reference | ✅ Yes | `customer.referenceId` field |
| Client reference | ✅ Yes | `externalPayment.reference` field |
| Duplicate-order detection | ✅ Yes | Same idempotency key + same request body = cached response |
| Duplicate detection (different body) | ✅ Yes | Returns 409 `idempotency_key_mismatch` |

### 9.2 Deterministic Idempotency Key

```typescript
function buildIdempotencyKey(purchaseId: string, step: string): string {
  // Deterministic based on our purchase ID + operation step
  // Same purchase + same step = same key = cached response
  return `onesim-${purchaseId}-${step}`;
}
```

Steps:
- `onesim-{purchaseId}-create` — order creation
- `onesim-{purchaseId}-submit` — order submission

### 9.3 Protection Against Each Scenario

| Scenario | Protection | Recovery |
|----------|-----------|----------|
| Double-click purchase | 30s dedup window in `createOrder()` + idempotency key on order create | Return existing order |
| Timeout after order creation | Idempotency key on order create + poll order by seamlessOrderId | Re-fetch order state |
| Timeout after submission | Idempotency key on submit (409 = already submitted) + poll order | Re-fetch order state |
| Local failure after provider success | `providerPurchaseKey` stored on `eSIMPurchase` record | Reconciliation job checks SeamlessOS orders |
| PM2 restart during fulfilment | Order persists in DB with `seamlessOrderId` in config JSON | `batchSyncPendingEsims()` picks up pending orders |
| Admin retry | Same idempotency key used — SeamlessOS returns cached response | No duplicate order |
| Duplicated subscription creation | Idempotency key prevents duplicate order → no duplicate subscription | N/A |

### 9.4 Reconciliation

A background job (`reconcilePendingSeamlessOrders()`) runs every 5 minutes:

1. Query `eSIMPurchase` records with `config.strategy === 'TELNA_SEAMLESS'` and `status` in `[PENDING_PROVIDER, RESERVED]`
2. For each, fetch `GET /orders/{seamlessOrderId}`
3. If COMPLETED → extract subscription, create eSIM, capture wallet
4. If FAILED/CANCELLED → release wallet, mark order failed
5. If still processing → continue polling
6. If 404 → mark as failed (order expired or was cancelled externally)

---

## 10. Pending and Reconciliation Design

### 10.1 State Transition Matrix

| Provider State | Internal Order Status | Internal eSIM Status | Wallet | Retry | Poll Endpoint | Terminal? |
|---------------|----------------------|---------------------|--------|-------|---------------|-----------|
| Order created, not submitted | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | HOLD | Auto-submit on next poll | `GET /orders/{id}` | No |
| Order submitted, processing | `PENDING_PROVIDER` | `PENDING_ACTIVATION` | HOLD | Poll with backoff | `GET /orders/{id}` | No |
| Order COMPLETED, subscription pending | `FULFILLING` | `PENDING_ACTIVATION` | HOLD | Poll subscription | `GET /subscriptions/{id}` | No |
| Subscription ACTIVE, QR pending | `FULFILLING` | `PENDING_ACTIVATION` | HOLD | Poll QR endpoint | `GET /subscriptions/{id}/esim/qrcode` | No |
| QR available, ICCID missing | `FULFILLED` | `PENDING_ACTIVATION` | CAPTURE | Retry subscription fetch | `GET /subscriptions/{id}` | No |
| Terminal failure | `FAILED` | N/A | RELEASE | None | N/A | Yes |
| Order COMPLETED + subscription ACTIVE + QR retrieved | `FULFILLED` | `ACTIVE` | CAPTURE | None | N/A | Yes |

### 10.2 Pending Activation Handling

When `activateESIM()` cannot complete synchronously (timeout or async provisioning):

1. Return `{ activationId: seamlessOrderId, iccids: [], status: 'PENDING' }`
2. `saveESIMs()` in `provider-purchase.ts` creates eSIM record with `status: 'PENDING_ACTIVATION'`
3. `batchSyncPendingEsims()` runs periodically (every 5 minutes via cron)
4. For each pending eSIM:
   - Load `eSIMPurchase.config.seamlessOrderId`
   - Call `getStatus(seamlessOrderId)` → which calls `GET /orders/{id}` or `GET /subscriptions/{id}`
   - If subscription is ACTIVE → call `getQRCode()` → update eSIM record
   - If order is FAILED → release wallet, mark eSIM as FAILED

### 10.3 Reconciliation Queries

```typescript
// Find SeamlessOS purchases stuck in processing
const stuckOrders = await prisma.eSIMPurchase.findMany({
  where: {
    status: { in: ['PENDING_PROVIDER', 'RESERVED'] },
    config: { path: ['strategy'], equals: 'TELNA_SEAMLESS' }
  },
  include: { esims: true }
})

// Find SeamlessOS eSIMs pending activation
const pendingESIMs = await prisma.eSIM.findMany({
  where: {
    status: 'PENDING_ACTIVATION',
    purchase: {
      config: { path: ['strategy'], equals: 'TELNA_SEAMLESS' }
    }
  },
  include: { purchase: true }
})
```

---

## 11. Provider Framework V2 Integration

### 11.1 Provider Strategy Registration

In the V2 seed script, register a `TELNA_SEAMLESS` feature pack:

```typescript
await prisma.pV2FeaturePack.upsert({
  where: { code: 'TELNA_SEAMLESS' },
  create: {
    code: 'TELNA_SEAMLESS',
    name: 'Telna SeamlessOS',
    description: 'SeamlessOS BSS/OSS platform for eSIM activation',
    status: 'ACTIVE',
    operations: {
      create: [
        { operationCode: 'OFFERING_SYNC', isRequired: true },
        { operationCode: 'ORDER_CREATE', isRequired: true },
        { operationCode: 'ORDER_SUBMIT', isRequired: true },
        { operationCode: 'ORDER_POLL', isRequired: true },
        { operationCode: 'SUBSCRIPTION_RETRIEVE', isRequired: true },
        { operationCode: 'QR_RETRIEVE', isRequired: true },
        { operationCode: 'SUBSCRIPTION_STATUS', isRequired: true },
        { operationCode: 'SUBSCRIPTION_USAGE', isRequired: true },
        { operationCode: 'SUBSCRIPTION_TOPUP', isRequired: false },
        { operationCode: 'SUBSCRIPTION_SUSPEND', isRequired: false },
        { operationCode: 'SUBSCRIPTION_RESTORE', isRequired: false },
      ]
    }
  }
})
```

### 11.2 Provider Credential Storage

The SeamlessOS provider record stores:

| Field | Value | Notes |
|-------|-------|-------|
| `apiToken` | Encrypted X-API-Key | Primary credential |
| `apiBaseUrl` | `https://SEAMLESSOS_BASE_URL` | Base URL |
| `adapterStrategy` | `TELNA_SEAMLESS` | Routes to new connector |
| `authorizationMode` | `API_KEY` | New mode for SeamlessOS |
| `config.environment` | `staging` or `production` | Environment selector |
| `config.customerType` | `CONSUMER` or `BUSINESS` | Default customer type |

### 11.3 Endpoint Configuration (V2 Template)

If using V2 templates, endpoints are configured in `PV2TemplateEndpoint`:

| Endpoint Key | HTTP Method | Relative Path | Operation |
|-------------|-------------|---------------|-----------|
| `list_offerings` | GET | `/product-offerings` | OFFERING_SYNC |
| `get_offering` | GET | `/product-offerings/{productOfferingId}` | OFFERING_SYNC |
| `create_order` | POST | `/orders` | ORDER_CREATE |
| `add_line_item` | POST | `/orders/{orderId}/line-items` | ORDER_CREATE |
| `submit_order` | POST | `/orders/{orderId}/submit` | ORDER_SUBMIT |
| `get_order` | GET | `/orders/{orderId}` | ORDER_POLL |
| `get_subscription` | GET | `/subscriptions/{subscriptionId}` | SUBSCRIPTION_RETRIEVE |
| `get_qrcode` | GET | `/subscriptions/{subscriptionId}/esim/qrcode` | QR_RETRIEVE |
| `get_usage` | GET | `/subscriptions/{subscriptionId}/usage` | SUBSCRIPTION_USAGE |
| `suspend_subscription` | POST | `/subscriptions/{subscriptionId}/suspend` | SUBSCRIPTION_SUSPEND |
| `restore_subscription` | POST | `/subscriptions/{subscriptionId}/restore` | SUBSCRIPTION_RESTORE |
| `cancel_subscription` | POST | `/subscriptions/{subscriptionId}/cancel` | SUBSCRIPTION_CANCEL |

### 11.4 Field Mappings (V2 Template)

Request mappings for order creation:

| Source Path | Destination Path | Type | Required |
|------------|-----------------|------|----------|
| `input.planId` | `body.lineItems[0].productOfferingId` | STRING | Yes |
| `input.subscriber.email` | `body.customer.contact.email` | STRING | Yes |
| `input.subscriber.first_name` | `body.customer.name` | STRING | Yes |
| `input.externalId` | `body.customer.referenceId` | STRING | No |
| `input.quantity` | `body.lineItems[0].sim.esim` | BOOLEAN | Yes (always true) |

Response mappings for subscription retrieval:

| Source Path | Destination Path | Type |
|------------|-----------------|------|
| `response.subscriptionId` | `output.activationId` | STRING |
| `response.iccid` or `response.sim.iccid` | `output.iccids[0]` | STRING |
| `response.status` | `output.status` | STRING |

SEAMLESSOS DOCUMENTATION REQUIRED: Confirm exact response field paths for subscription and QR endpoints.

### 11.5 Health Checks

```typescript
// V2 health check configuration
{
  endpointKey: 'list_offerings',
  operationId: 'OFFERING_SYNC',
  expectedStatuses: [200],
  intervalMs: 60000,      // every minute
  timeoutMs: 10000,
  failureThreshold: 3,    // mark unhealthy after 3 failures
  recoveryThreshold: 2    // mark healthy after 2 successes
}
```

### 11.6 Versioning

The V2 template for SeamlessOS starts at `semanticVersion: '1.0.0'`. When SeamlessOS introduces breaking API changes:

1. Create new `PV2TemplateVersion` with incremented version
2. Update endpoint paths, field mappings, error mappings
3. Providers can upgrade by pointing to new version
4. Old version remains available for existing providers

---

## 12. Required Code Changes by File

### 12.1 New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/lib/providers/connectors/telna-seamless-connector.ts` | New connector class implementing `IProviderConnector` | ~500 |
| `src/lib/providers/connectors/telna-seamless-endpoints.ts` | Endpoint constants, DTOs, response types | ~400 |
| `src/lib/providers/connectors/telna-seamless-connector.test.ts` | Comprehensive test suite | ~1200 |

### 12.2 Modified Files

| File | Change | Lines Changed |
|------|--------|--------------|
| `src/lib/providers/connectors/connector-factory.ts` | Add `'TELNA_SEAMLESS'` to `ConnectorType`, add case in `resolveConnectorType()`, add case in `createConnector()` | ~15 |
| `src/lib/providers/adapter-manager.ts` | Add `TELNA_SEAMLESS` exclusion in `isTemplateDrivenProvider()` (line ~146) | ~2 |
| `src/lib/providers/capabilities/defaults.ts` | Add `TELNA_SEAMLESS` capability declaration | ~5 |
| `src/lib/providers/provider-validation.ts` | Add `validateTelnaSeamlessConfig()` function | ~30 |
| `src/lib/services/orders/provider-purchase.ts` | Add `seamlessOrderId` extraction in `mapProviderResponse()`, handle async pending activation in `initiateAndFulfillPurchase()` | ~40 |

### 12.3 Unchanged Files

| File | Reason |
|------|--------|
| `src/lib/providers/connectors/telna-connector.ts` | Legacy connector — no modifications |
| `src/lib/providers/connectors/telna-endpoints.ts` | Legacy endpoints — no modifications |
| `src/lib/providers/connectors/telna-connector.test.ts` | Legacy tests — no modifications |
| `src/lib/services/esims/sync-esim-status.ts` | Already works generically — calls `adapter.getActivationStatus()` |
| `src/lib/services/orders/create-order.ts` | No changes needed — dispatches via adapter |
| `src/lib/services/orders/order-state-machine.ts` | No changes needed — transitions are generic |

---

## 13. Schema Impact

### 13.1 No Migration Required

All existing schema fields are sufficient:

- `eSIMPurchase.providerReservationId` → stores SeamlessOS order ID
- `eSIMPurchase.providerActivationId` → stores SeamlessOS subscription ID
- `eSIMPurchase.providerPurchaseKey` → stores deterministic idempotency key
- `eSIMPurchase.config` (JSON) → stores `seamlessOrderId`, `seamlessLineItemId`, `strategy`
- `eSIM.iccid` → stores ICCID from subscription
- `eSIM.qrCodeUrl` → stores QR code data
- `eSIM.providerStatus` → stores SeamlessOS subscription state

### 13.2 Provider Record Updates

The existing `providers` table needs no schema changes. The new provider is created with:

```sql
INSERT INTO providers (id, name, code, type, adapterStrategy, apiBaseUrl, apiToken, status, ...)
VALUES (
  gen_random_uuid()::text,
  'Telna SeamlessOS',
  'TELNA_SEAMLESS',
  'TELNA_SEAMLESS',
  'TELNA_SEAMLESS',
  'https://SEAMLESSOS_BASE_URL',
  -- encrypted API key
  'ACTIVE',
  ...
);
```

---

## 14. Test Plan

### 14.1 Unit Tests (telna-seamless-connector.test.ts)

| Test Category | Tests | Count |
|--------------|-------|-------|
| Authentication | API key present, missing, invalid | 3 |
| Connection test | Success, 401, 403, 429, timeout, network error | 6 |
| Offering sync | Success with pagination, empty, 401, 404, malformed | 5 |
| Order creation | Success, validation error, idempotent retry, timeout | 4 |
| Order submission | Success, already submitted (409), invalid state (412), timeout | 4 |
| Order polling | COMPLETED, PROCESSING, FAILED, timeout | 4 |
| Subscription retrieval | Success, not found, pending | 3 |
| QR retrieval | Success, not ready, timeout | 3 |
| Successful activation | Full happy path end-to-end mock | 1 |
| Pending order | Order stays PROCESSING, returns PENDING | 1 |
| Pending subscription | Subscription PENDING, returns PENDING | 1 |
| ICCID mapping | Various response shapes, fallback paths | 3 |
| Malformed response | Missing fields, wrong types, empty body | 3 |
| HTTP errors | 400, 401, 403, 404, 409, 412, 429, 500 | 8 |
| Idempotent retry | Same key returns cached, different key returns 409 | 2 |
| Top-up | Create addon order, success, error | 2 |
| Suspend/Resume | Success, error | 2 |
| Usage retrieval | Success, empty, error | 3 |
| Error classification | All error codes mapped correctly | 5 |
| Status normalization | All order states → internal states | 9 |
| Legacy coexistence | Factory routes TELNA vs TELNA_SEAMLESS correctly | 3 |

**Estimated total: ~75 tests**

### 14.2 Integration Tests

| Test | Scenario |
|------|----------|
| Wallet hold on pending | Order created, wallet reserved, order still processing → wallet stays reserved |
| Wallet release on failure | Order fails → wallet released |
| Wallet capture on fulfilment | Order completed, subscription active, QR retrieved → wallet captured |
| Legacy + Seamless coexist | Two providers, different strategies, both callable |

### 14.3 Mock Strategy

```typescript
// Same pattern as existing Telna and AirHub tests
vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    eSIM: { findMany: vi.fn(), update: vi.fn() },
  }
}))

vi.mock('@/lib/encryption', () => ({
  decryptToken: vi.fn((t: string) => t.replace('enc:', '')),
  encryptToken: vi.fn((t: string) => `enc:${t}`),
}))

// Mock fetch for SeamlessOS API calls
vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse)
```

---

## 15. Deployment and Rollback Plan

### 15.1 Rollout Phases

#### Phase 1: Staging (Week 1)
1. Deploy new files (connector, endpoints, tests)
2. Run all 75+ unit tests — verify pass
3. Run full test suite (existing 546 + new 75 = ~621 tests)
4. Create staging provider record with `adapterStrategy: 'TELNA_SEAMLESS'`
5. Configure staging SeamlessOS API key
6. Sync product offerings from SeamlessOS
7. Execute single low-value order
8. Verify: order created → submitted → completed → subscription retrieved → QR code obtained → eSIM created → wallet captured
9. Verify legacy Telna provider still works with existing tests

#### Phase 2: Production Canary (Week 2)
1. Deploy to production (behind `TESTING` provider status)
2. Create production provider record with `adapterStrategy: 'TELNA_SEAMLESS'`, status `TESTING`
3. Execute 3-5 test orders with real (low-value) offerings
4. Verify end-to-end: purchase → activation → status sync → usage
5. Monitor structured logs for errors
6. Verify legacy Telna provider unchanged

#### Phase 3: Production Enable (Week 3)
1. Change provider status from `TESTING` to `ACTIVE`
2. Enable in admin panel
3. Monitor for 48 hours
4. Verify batch status sync works for SeamlessOS eSIMs

#### Phase 4: Legacy Deprecation (Week 4+)
1. After 30 days of SeamlessOS stability
2. Add deprecation notice to legacy Telna provider
3. Do NOT remove legacy connector — it remains available for existing SIM management
4. Legacy provider status changed to `DEPRECATED` (not `INACTIVE`)

### 15.2 Rollback Procedure

If SeamlessOS activation fails in production:

1. **Immediate:** Set provider status to `INACTIVE` — new purchases stop
2. **5 minutes:** Switch `adapterStrategy` to `TELNA` — routes to legacy connector
3. **1 hour:** If legacy connector has working activation endpoints, purchases resume via legacy
4. **If legacy not viable:** Keep SeamlessOS connector, fix issues, redeploy

**Rollback does NOT require:**
- Code deployment (strategy switch is config-only)
- Database migration (no schema changes)
- Service restart (config is read per-request)

---

## 16. Risks and Open Questions

### 16.1 Confirmed (No Risk)

- ✅ SeamlessOS API authentication: `X-API-Key` header
- ✅ Order lifecycle: PENDING → SUBMITTED → PROCESSING → COMPLETED
- ✅ Idempotency: `X-Idempotency-Key` header, 24h expiry
- ✅ Error structure: `{ message, code, details, hint }`
- ✅ Travel eSIM pattern: SUBSCRIPTION + ADDON line items
- ✅ QR code endpoint: `GET /subscriptions/{id}/esim/qrcode`
- ✅ External payment: `externalPayment` object for wallet-based payments
- ✅ No schema migration needed

### 16.2 Open Questions

| # | Question | Impact | Priority |
|---|----------|--------|----------|
| 1 | What is the exact SeamlessOS API base URL hostname? | Cannot make API calls without it | **BLOCKER** |
| 2 | What is the exact response shape of `GET /subscriptions/{id}`? (ICCID field name?) | ICCID extraction in activation flow | **HIGH** |
| 3 | What is the exact response shape of `GET /subscriptions/{id}/esim/qrcode`? | QR code extraction | **HIGH** |
| 4 | What is the exact response shape of `GET /subscriptions/{id}/usage`? | Usage sync | **MEDIUM** |
| 5 | Does SeamlessOS support Travel eSIM categories for our African markets? | Product offering availability | **MEDIUM** |
| 6 | What are the SeamlessOS rate limits? | Backoff configuration | **LOW** |
| 7 | Does SeamlessOS support SMS APIs? | SMS capability declaration | **LOW** |
| 8 | How does SeamlessOS handle order expiry timeout? (7 days per docs) | Reconciliation timing | **LOW** |

### 16.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SeamlessOS base URL changes | Low | High | Store in provider config, not hardcoded |
| Subscription response shape differs from expected | Medium | High | Multi-path field extraction (like AirHub pattern) |
| QR code response is async (not immediate) | Medium | Medium | Poll QR endpoint with backoff |
| Product offerings not available for African markets | Medium | High | Test in staging before production |
| SeamlessOS deprecates API version | Low | Medium | V2 template versioning |
| External payment not accepted for our use case | Low | High | Test in staging — may need `paymentSessionId` instead |

---

## Summary

| Section | Status |
|---------|--------|
| SeamlessOS Architecture | ✅ Complete |
| Legacy Coexistence Strategy | ✅ Complete |
| Confirmed Endpoint Contracts | ✅ Complete (3 items need live API confirmation) |
| Connector Method Mapping | ✅ Complete |
| Full Activation Sequence | ✅ Complete (8-step flow) |
| Identifier Persistence Mapping | ✅ Complete (no schema migration) |
| Status Normalization Table | ✅ Complete |
| Error and Wallet Action Matrix | ✅ Complete (17 error conditions) |
| Idempotency Design | ✅ Complete |
| Pending and Reconciliation Design | ✅ Complete |
| Provider Framework V2 Integration | ✅ Complete |
| Required Code Changes by File | ✅ Complete (3 new, 5 modified) |
| Schema Impact | ✅ Complete (none required) |
| Test Plan | ✅ Complete (~75 new tests) |
| Deployment and Rollback Plan | ✅ Complete (4-phase rollout) |
| Risks and Open Questions | ✅ Complete (1 blocker, 3 high) |

---

READY TO IMPLEMENT
