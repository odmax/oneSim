import { NextResponse } from 'next/server'

const BASE_URL = process.env.API_BASE_URL || 'https://api.onesim.africa'
const SANDBOX_URL = process.env.API_SANDBOX_URL || 'https://sandbox.onesim.africa'

export function GET() {
  const spec: any = {
    openapi: '3.1.0',
    info: {
      title: 'OneSIM Business API',
      version: 'v1',
      description: `Business API for eSIM purchasing, quoting, order management, webhooks and inventory.

## Authentication
Every request must include an \`Authorization: Bearer ONESIM_API_KEY\` header (key prefix \`onesim_\`).

## Authorization scopes
API keys carry a set of scopes. Each endpoint requires the scope listed under its \`x-required-scope\` extension:

- 401 \`UNAUTHORIZED\` — missing/invalid/expired/revoked API key
- 403 \`FORBIDDEN\` — authenticated but the key lacks the required scope for this route
- 403 \`FORBIDDEN\` — resource belongs to a different business (tenant isolation)

Businesses interact with OneSIM only — no provider identifiers, provider credentials, or provider wallet balances are ever exposed.`,
    },
    servers: [
      { url: `${BASE_URL}/api/v1`, description: 'Production' },
      { url: `${SANDBOX_URL}/api/v1`, description: 'Sandbox' },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API Key', description: 'API key generated from the Developer Portal. Prefix: `onesim_`.' },
      },
      schemas: {
        ApiError: {
          type: 'object', properties: {
            error: {
              type: 'object', required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', enum: ['INVALID_REQUEST','UNAUTHORIZED','FORBIDDEN','NOT_FOUND','CONFLICT','RATE_LIMITED','INSUFFICIENT_BALANCE','QUOTE_REQUIRED','QUOTE_EXPIRED','IDEMPOTENCY_CONFLICT','ORDER_NOT_RETRYABLE','INTERNAL_ERROR','SERVICE_UNAVAILABLE'] },
                message: { type: 'string' },
                details: { type: 'object' },
                requestId: { type: 'string', example: 'req_m0abc123_abcd' },
              },
            },
          },
        },
        RequestId: { type: 'object', properties: { requestId: { type: 'string' } } },
        Package: {
          type: 'object', required: ['id', 'name', 'dataGB', 'validityDays', 'unitPrice', 'currency', 'isActive', 'source'],
          properties: {
            id: { type: 'string' }, sku: { type: 'string', nullable: true }, packageCode: { type: 'string', nullable: true },
            displayName: { type: 'string', nullable: true }, name: { type: 'string' },
            customerDescription: { type: 'string', nullable: true }, description: { type: 'string', nullable: true },
            dataGB: { type: 'integer' }, validityDays: { type: 'integer' },
            unitPrice: { type: 'number' }, currency: { type: 'string' },
            country: { type: 'string', nullable: true }, region: { type: 'string', nullable: true },
            productType: { type: 'string', enum: ['NEW_ESIM', 'TOP_UP'] },
            isActive: { type: 'boolean' }, requiresTravelDate: { type: 'boolean' },
            source: { type: 'string', enum: ['CATALOG_PRODUCT', 'MANUAL'] },
          },
        },
        Order: {
          type: 'object', required: ['id', 'status', 'quantity', 'unitCost', 'totalCost', 'currency', 'createdAt'],
          properties: {
            id: { type: 'string' }, status: { type: 'string', enum: ['CREATED','PAYMENT_RESERVED','PENDING_PROVIDER','PROVIDER_ACCEPTED','RESERVED','FULFILLING','PARTIALLY_FULFILLED','FULFILLED','PROVIDER_RECONCILIATION','FAILED','CANCELLED','REFUNDED'] },
            quantity: { type: 'integer' }, unitCost: { type: 'number' }, totalCost: { type: 'number' }, currency: { type: 'string' },
            fulfilledQuantity: { type: 'integer' }, failedQuantity: { type: 'integer' },
            callbackUrl: { type: 'string', nullable: true }, travelDate: { type: 'string', nullable: true },
            package: { type: 'object', properties: {
              id: { type: 'string' }, displayName: { type: 'string' }, dataGB: { type: 'integer' },
              validityDays: { type: 'integer' }, priceUSD: { type: 'number' }, currency: { type: 'string' },
            }},
            esims: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' }, iccid: { type: 'string' }, imsi: { type: 'string' },
              status: { type: 'string' }, expiresAt: { type: 'string' },
              dataUsedMB: { type: 'integer' }, dataRemainingMB: { type: 'integer' },
            }}},
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ESIM: {
          type: 'object', properties: {
            id: { type: 'string' }, iccid: { type: 'string' }, status: { type: 'string', enum: ['PENDING','PENDING_ACTIVATION','ACTIVE','SUSPENDED','EXPIRED','FAILED'] },
            statusLabel: { type: 'string', enum: ['Ready to install','Active','Suspended','Expired','Failed'] },
            qrCodeUrl: { type: 'string' }, activationCode: { type: 'string' },
            activatedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
            dataUsedMB: { type: 'integer' }, dataTotalMB: { type: 'integer' }, dataRemainingMB: { type: 'integer' },
            package: { $ref: '#/components/schemas/Package' },
            lastUsageAt: { type: 'string', format: 'date-time' },
          },
        },
        Customer: {
          type: 'object', properties: {
            id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' },
            phone: { type: 'string' }, country: { type: 'string' },
            status: { type: 'string' }, esimCount: { type: 'integer' },
          },
        },
      },
    },
    paths: {
'/packages': {
        get: {
          summary: 'List available eSIM packages', tags: ['Packages'], 'x-required-scope': 'packages:read',
          responses: { '200': { description: 'Package list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, packages: { type: 'array', items: { $ref: '#/components/schemas/Package' } } } } } } } },
        },
      },
      '/esims/order': {
        get: {
          summary: 'List recent orders (alias)', tags: ['Orders'], 'x-required-scope': null,
          description: 'Bootstrap/service banner — no authentication or scope required.',
          responses: { '200': { description: 'Service banner' } },
        },
        post: {
          summary: 'Create an eSIM order', tags: ['Orders'], 'x-required-scope': 'orders:write',
          description: 'Place a new order. Use `Idempotency-Key` header for safe retries. Returns the order with status and eSIM details when fulfilled.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['packageId', 'customerName', 'customerEmail'], properties: { packageId: { type: 'string', description: 'Package ID (or use sku/packageCode)' }, sku: { type: 'string', description: 'Package SKU (alternative to packageId)' }, packageCode: { type: 'string', description: 'Package code (alternative to packageId)' }, quantity: { type: 'integer', default: 1, minimum: 1, maximum: 100 }, customerName: { type: 'string' }, customerEmail: { type: 'string', format: 'email' }, customerPhone: { type: 'string' }, country: { type: 'string' }, externalCustomerId: { type: 'string' }, callbackUrl: { type: 'string', format: 'uri' }, travelDate: { type: 'string', format: 'date' } } } } } },
          responses: {
            '200': { description: 'Order created (may be processing)', content: { 'application/json': { schema: { type: 'object', properties: {
              success: { type: 'boolean' },
              order: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, quantity: { type: 'integer' }, unitCost: { type: 'number' }, totalCost: { type: 'number' }, currency: { type: 'string' }, createdAt: { type: 'string' } } },
              package: { $ref: '#/components/schemas/Package' },
              esims: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, iccid: { type: 'string' }, status: { type: 'string' }, activationCode: { type: 'string' }, qrCodeUrl: { type: 'string' }, expiresAt: { type: 'string' } } } },
              wallet: { type: 'object', properties: { deducted: { type: 'number' }, currency: { type: 'string' } } },
            } } } } },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '409': { description: 'Idempotency conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '429': { description: 'Rate limited', headers: { 'Retry-After': { schema: { type: 'string', example: '60' } }, 'X-RateLimit-Limit': { schema: { type: 'integer' } }, 'X-RateLimit-Remaining': { schema: { type: 'integer' } }, 'X-RateLimit-Reset': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/orders': {
        get: { summary: 'List all orders', tags: ['Orders'], 'x-required-scope': 'orders:read', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'List of orders' } } },
      },
      '/orders/{orderId}': {
        get: { summary: 'Get order detail', tags: ['Orders'], 'x-required-scope': 'orders:read', parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Order detail' } } },
      },
      '/esims/{esimId}': {
        get: { summary: 'Get eSIM detail', tags: ['eSIMs'], 'x-required-scope': 'esims:read', parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'eSIM detail' } } },
      },
      '/esims/{esimId}/usage': {
        get: { summary: 'Get eSIM usage records', tags: ['eSIMs'], 'x-required-scope': 'esims:read', parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Usage records (last 100)' } } },
      },
      '/esims/{esimId}/refresh-status': {
        post: { summary: 'Refresh eSIM status from provider', tags: ['eSIMs'], 'x-required-scope': 'esims:write', parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Status refreshed' } } },
      },
      '/esims/{esimId}/refresh-qr': {
        post: {
          summary: 'Refresh eSIM QR code / installation data', tags: ['eSIMs'], 'x-required-scope': 'esims:write',
          description: 'Retrieves the latest QR code and installation data from the provider. This operation is read-only — it does not purchase another eSIM, change the ICCID, or mutate the wallet. Provider support may vary. Refreshing is safe to retry.',
          parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' }, description: 'eSIM ID' }],
          responses: {
            '200': {
              description: 'QR code refreshed',
              content: { 'application/json': { schema: { type: 'object', properties: {
                success: { type: 'boolean' },
                esim: { type: 'object', properties: {
                  id: { type: 'string' }, iccid: { type: 'string' }, status: { type: 'string' },
                  activationCode: { type: 'string', nullable: true }, qrCodeUrl: { type: 'string', nullable: true },
                  qrCode: { type: 'string', nullable: true }, smdpAddress: { type: 'string', nullable: true },
                  matchingId: { type: 'string', nullable: true },
                  installation: { type: 'object', properties: {
                    kind: { type: 'string', enum: ['QR_IMAGE_URL', 'QR_PAYLOAD', 'ACTIVATION_CODE', 'MANUAL', 'NONE'] },
                    qrImageUrl: { type: 'string', nullable: true }, qrPayload: { type: 'string', nullable: true },
                    activationCode: { type: 'string', nullable: true }, smdpAddress: { type: 'string', nullable: true },
                    matchingId: { type: 'string', nullable: true },
                  }},
                  qrRefreshedAt: { type: 'string', format: 'date-time' },
                }},
              } } } },
            },
            '404': { description: 'eSIM not found or QR not available', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '422': { description: 'QR not supported or provider unresolved', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '502': { description: 'Provider request failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/esims/{esimId}/top-up': {
        post: { summary: 'Top-up an existing eSIM', tags: ['eSIMs'], 'x-required-scope': 'esims:write', parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['packageId'], properties: { packageId: { type: 'string' }, quantity: { type: 'integer' } } } } } }, responses: { '200': { description: 'Top-up completed' } } },
      },
      '/esims/{esimId}/share': {
        post: { summary: 'Share eSIM activation details', tags: ['eSIMs'], 'x-required-scope': 'esims:write', parameters: [{ name: 'esimId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Share link generated' } } },
      },
      '/usage': {
        get: { summary: 'List eSIMs with usage summaries', tags: ['Usage'], 'x-required-scope': 'esims:read', responses: { '200': { description: 'Usage summaries' } } },
      },
      '/wallet': {
        get: { summary: 'Get wallet balance', tags: ['Wallet'], 'x-required-scope': 'wallet:read', responses: { '200': { description: 'Wallet balance' } } },
      },
      '/wallet/transactions': {
        get: { summary: 'List wallet transactions', tags: ['Wallet'], 'x-required-scope': 'wallet:read', responses: { '200': { description: 'Transaction list' } } },
      },
      '/customers': {
        get: { summary: 'List customers', tags: ['Customers'], 'x-required-scope': 'customers:read', responses: { '200': { description: 'Customer list' } } },
        post: { summary: 'Create customer', tags: ['Customers'], 'x-required-scope': 'customers:write', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name','email'], properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, country: { type: 'string' } } } } } }, responses: { '201': { description: 'Customer created' } } },
      },
      '/customers/{id}': {
        get: { summary: 'Get customer detail', tags: ['Customers'], 'x-required-scope': 'customers:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Customer detail' } } },
        patch: { summary: 'Update customer', tags: ['Customers'], 'x-required-scope': 'customers:write', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Customer updated' } } },
      },
      '/webhooks': {
        get: { summary: 'List webhook endpoints', tags: ['Webhooks'], 'x-required-scope': 'webhooks:read', responses: { '200': { description: 'Webhook list' } } },
        post: { summary: 'Create webhook endpoint', tags: ['Webhooks'], 'x-required-scope': 'webhooks:write', responses: { '201': { description: 'Webhook created' } } },
      },
      '/webhooks/{id}': {
        get: { summary: 'Get webhook endpoint', tags: ['Webhooks'], 'x-required-scope': 'webhooks:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Webhook detail' } } },
        patch: { summary: 'Update webhook endpoint', tags: ['Webhooks'], 'x-required-scope': 'webhooks:write', responses: { '200': { description: 'Updated' } } },
        delete: { summary: 'Delete webhook endpoint', tags: ['Webhooks'], 'x-required-scope': 'webhooks:write', responses: { '200': { description: 'Deleted' } } },
      },
      '/webhooks/{id}/test': {
        post: { summary: 'Send test webhook', tags: ['Webhooks'], 'x-required-scope': 'webhooks:write', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Test result' } } },
      },
      '/webhooks/{id}/deliveries': {
        get: { summary: 'List webhook delivery history', tags: ['Webhooks'], 'x-required-scope': 'webhooks:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Delivery list' } } },
      },
      '/webhooks/deliveries/{deliveryId}/retry': {
        post: { summary: 'Retry failed webhook delivery', tags: ['Webhooks'], 'x-required-scope': 'webhooks:write', parameters: [{ name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Retry response' } } },
      },
      '/auth/verify': {
        get: { summary: 'Verify API key validity', tags: ['Authentication'], 'x-required-scope': null, responses: { '200': { description: 'Key is valid' } } },
      },
    },
    tags: [
      { name: 'Packages', description: 'Browse available eSIM packages' },
      { name: 'Orders', description: 'Create and manage orders. Orders may be asynchronous.' },
      { name: 'eSIMs', description: 'Manage individual eSIMs, usage, and activation' },
      { name: 'Usage', description: 'Data usage across eSIMs' },
      { name: 'Wallet', description: 'Business wallet balance and transactions' },
      { name: 'Customers', description: 'End-customer management' },
      { name: 'Webhooks', description: 'Configure outbound webhook callbacks' },
      { name: 'Authentication', description: 'Validate API keys' },
    ],
  }

  return NextResponse.json(spec, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
  })
}
