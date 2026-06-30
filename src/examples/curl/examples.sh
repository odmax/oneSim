# OneSim Africa API — cURL Examples
# Base URL: https://staging.onetelecom.cloud/api/v1
# Auth: x-api-key header

# 1. Verify API key
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/auth/verify

# 2. List available packages
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/packages

# 3. Create a customer
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"name":"John Doe","email":"john@example.com","country":"US"}' \
  https://staging.onetelecom.cloud/api/v1/customers

# 4. Order an eSIM (returns ICCID, QR code, activation code)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Idempotency-Key: your-unique-key-789" \
  -d '{
    "packageId": "PACKAGE_ID_HERE",
    "quantity": 1,
    "customerName": "John Doe",
    "customerEmail": "john@example.com"
  }' \
  https://staging.onetelecom.cloud/api/v1/esims/order

# 5. List orders
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/orders

# 6. Get order details
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/orders/ORDER_ID

# 7. Get eSIM details
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/esims/ESIM_ID

# 8. Get eSIM usage
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/esims/ESIM_ID/usage

# 9. Top-up an eSIM
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"packageId":"TOPUP_PACKAGE_ID","quantity":1}' \
  https://staging.onetelecom.cloud/api/v1/esims/ESIM_ID/top-up

# 10. Get wallet balance
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/wallet

# 11. Create webhook endpoint
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"name":"My Webhook","url":"https://myapp.com/webhooks/onesim","events":["*"]}' \
  https://staging.onetelecom.cloud/api/v1/webhooks

# 12. Test webhook
curl -X POST \
  -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/webhooks/WEBHOOK_ID/test

# 13. List webhook deliveries
curl -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/webhooks/WEBHOOK_ID/deliveries

# 14. Retry failed webhook delivery
curl -X POST \
  -H "x-api-key: YOUR_API_KEY" \
  https://staging.onetelecom.cloud/api/v1/webhooks/deliveries/DELIVERY_ID/retry

# Response format (success):
# {
#   "success": true,
#   "data": { ... },
#   "requestId": "req_xxx",
#   "timestamp": "2024-01-01T00:00:00.000Z"
# }

# Response format (error):
# {
#   "success": false,
#   "error": {
#     "code": "ERROR_CODE",
#     "message": "Human-readable error message"
#   },
#   "requestId": "req_xxx",
#   "timestamp": "2024-01-01T00:00:00.000Z"
# }

# Rate limit headers:
# X-RateLimit-Limit: 60
# X-RateLimit-Remaining: 58
# X-RateLimit-Reset: 1704067200
