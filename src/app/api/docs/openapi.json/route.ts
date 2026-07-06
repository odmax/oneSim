import { NextResponse } from 'next/server'

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'OneSIM Africa API',
    version: '1.0.0',
    description: 'RESTful API for ordering and managing eSIMs programmatically.\n\nAuthentication: All requests require an `x-api-key` header with your API key.\nBase URL: `https://staging.onetelecom.cloud/api/v1` or `https://m2m.onetelecom.cloud/api/v1`',
    contact: { name: 'OneSIM Support', email: 'support@onetelecom.cloud' },
  },
  servers: [
    { url: 'https://staging.onetelecom.cloud/api/v1', description: 'Staging' },
    { url: 'https://m2m.onetelecom.cloud/api/v1', description: 'Production' },
  ],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Your business API key from the dashboard' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'AUTH_FAILED' },
              message: { type: 'string', example: 'Invalid or missing API key' },
            },
          },
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Package: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          dataGB: { type: 'integer' },
          validityDays: { type: 'integer' },
          unitPrice: { type: 'number' },
          unitCost: { type: 'number' },
          currency: { type: 'string' },
          sku: { type: 'string' },
          packageCode: { type: 'string' },
          customerDescription: { type: 'string' },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          quantity: { type: 'integer' },
          unitCost: { type: 'number' },
          totalCost: { type: 'number' },
          currency: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          package: { $ref: '#/components/schemas/Package' },
          esims: {
            type: 'array',
            items: { $ref: '#/components/schemas/ESIM' },
          },
        },
      },
      ESIM: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          iccid: { type: 'string' },
          imsi: { type: 'string', nullable: true },
          activationCode: { type: 'string', nullable: true },
          qrCodeUrl: { type: 'string', nullable: true },
          status: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          dataUsedMB: { type: 'integer' },
          dataRemainingMB: { type: 'integer', nullable: true },
          dataTotalMB: { type: 'integer', nullable: true },
          activationInstructions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      Customer: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string', nullable: true },
          country: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Wallet: {
        type: 'object',
        properties: {
          balance: { type: 'number' },
          currency: { type: 'string' },
          totalUsed: { type: 'number' },
          pendingCreditRequests: { type: 'integer' },
        },
      },
      WebhookEndpoint: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          status: { type: 'string' },
          events: { type: 'array', items: { type: 'string' } },
          secret: { type: 'string' },
          lastSuccessAt: { type: 'string', format: 'date-time', nullable: true },
          lastFailureAt: { type: 'string', format: 'date-time', nullable: true },
          failureCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      WebhookDelivery: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventType: { type: 'string' },
          status: { type: 'string' },
          attempts: { type: 'integer' },
          responseCode: { type: 'integer', nullable: true },
          sentAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    headers: {
      RateLimitLimit: { schema: { type: 'integer' }, description: 'Max requests per minute' },
      RateLimitRemaining: { schema: { type: 'integer' }, description: 'Requests remaining in current window' },
      RateLimitReset: { schema: { type: 'integer' }, description: 'Unix timestamp when limit resets' },
    },
  },
  paths: {
    '/packages': {
      get: {
        tags: ['Packages'],
        summary: 'List available packages',
        description: 'Retrieve all active eSIM packages available for purchase.',
        responses: {
          '200': {
            description: 'Package list',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, packages: { type: 'array', items: { $ref: '#/components/schemas/Package' } } } } } },
          },
          '401': { description: 'Invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/esims/order': {
      post: {
        tags: ['Orders'],
        summary: 'Order eSIM',
        description: 'Create a new eSIM order. Supports Idempotency-Key header to prevent duplicate orders.',
        parameters: [
          { in: 'header', name: 'Idempotency-Key', schema: { type: 'string' }, description: 'Unique key for idempotency (optional)' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customerName', 'customerEmail'],
                properties: {
                  packageId: { type: 'string', description: 'Package ID from /packages' },
                  sku: { type: 'string', description: 'Package SKU (alternative to packageId)' },
                  packageCode: { type: 'string', description: 'Package code (alternative to packageId)' },
                  quantity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
                  customerName: { type: 'string' },
                  customerEmail: { type: 'string', format: 'email' },
                  customerPhone: { type: 'string' },
                  country: { type: 'string' },
                  externalCustomerId: { type: 'string', description: 'Your internal customer ID' },
                  callbackUrl: { type: 'string', format: 'uri', description: 'Webhook URL for order events' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Order created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, order: { $ref: '#/components/schemas/Order' }, esims: { type: 'array', items: { $ref: '#/components/schemas/ESIM' } } } } } } },
          '402': { description: 'Insufficient wallet balance' },
          '422': { description: 'Validation error' },
        },
      },
    },
    '/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List orders',
        description: 'Retrieve all orders for your business.',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' }, description: 'Filter by status (e.g. ACTIVE, FULFILLED, FAILED)' },
        ],
        responses: { '200': { description: 'Order list' } },
      },
    },
    '/orders/{orderId}': {
      get: {
        tags: ['Orders'],
        summary: 'Get order details',
        parameters: [{ in: 'path', name: 'orderId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Order details' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
      },
    },
    '/esims/{esimId}': {
      get: {
        tags: ['eSIMs'],
        summary: 'Get eSIM details',
        parameters: [{ in: 'path', name: 'esimId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'eSIM details with usage' }, '404': { description: 'Not found' } },
      },
    },
    '/esims/{esimId}/usage': {
      get: {
        tags: ['eSIMs'],
        summary: 'Get eSIM usage',
        parameters: [{ in: 'path', name: 'esimId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Usage data with history' } },
      },
    },
    '/esims/{esimId}/top-up': {
      post: {
        tags: ['eSIMs'],
        summary: 'Top-up eSIM',
        description: 'Add data and validity to an existing eSIM.',
        parameters: [{ in: 'path', name: 'esimId', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', required: ['packageId'], properties: { packageId: { type: 'string' }, sku: { type: 'string' }, quantity: { type: 'integer', default: 1 } } } } },
        },
        responses: { '200': { description: 'Top-up completed' } },
      },
    },
    '/customers': {
      get: {
        tags: ['Customers'],
        summary: 'List customers',
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 } },
          { in: 'query', name: 'search', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Customer list' } },
      },
      post: {
        tags: ['Customers'],
        summary: 'Create customer',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, country: { type: 'string' } } } } } },
        responses: { '200': { description: 'Customer created' }, '409': { description: 'Duplicate email' } },
      },
    },
    '/customers/{id}': {
      get: {
        tags: ['Customers'],
        summary: 'Get customer details',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Customer details' } },
      },
      patch: {
        tags: ['Customers'],
        summary: 'Update customer',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, country: { type: 'string' }, status: { type: 'string' } } } } } },
        responses: { '200': { description: 'Customer updated' } },
      },
    },
    '/wallet': {
      get: {
        tags: ['Wallet'],
        summary: 'Get wallet balance',
        responses: { '200': { description: 'Wallet details' } },
      },
    },
    '/wallet/transactions': {
      get: {
        tags: ['Wallet'],
        summary: 'List wallet transactions',
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 } },
          { in: 'query', name: 'type', schema: { type: 'string' }, description: 'Filter by type' },
        ],
        responses: { '200': { description: 'Transaction list' } },
      },
    },
    '/auth/verify': {
      get: {
        tags: ['Authentication'],
        summary: 'Verify API key',
        responses: { '200': { description: 'Key is valid' }, '401': { description: 'Invalid key' } },
      },
    },
    '/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook endpoints',
        responses: { '200': { description: 'Webhook list' } },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Create webhook endpoint',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'url'], properties: { name: { type: 'string' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string' }, description: 'Event types or ["*"] for all' } } } } } },
        responses: { '200': { description: 'Webhook created with secret' } },
      },
    },
    '/webhooks/{id}': {
      get: { tags: ['Webhooks'], summary: 'Get webhook endpoint', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Webhook details' } } },
      delete: { tags: ['Webhooks'], summary: 'Delete webhook endpoint', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } },
      patch: { tags: ['Webhooks'], summary: 'Update webhook endpoint', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
    },
    '/webhooks/{id}/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Send test webhook',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Test sent' } },
      },
    },
    '/webhooks/{id}/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook deliveries',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Delivery list' } },
      },
    },
    '/webhooks/deliveries/{deliveryId}/retry': {
      post: {
        tags: ['Webhooks'],
        summary: 'Retry webhook delivery',
        parameters: [{ in: 'path', name: 'deliveryId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Retry initiated' } },
      },
    },
    '/usage': {
      get: {
        tags: ['Usage'],
        summary: 'Get aggregated usage',
        responses: { '200': { description: 'Usage data' } },
      },
    },
  },
}

export async function GET() {
  return Response.json(spec, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
