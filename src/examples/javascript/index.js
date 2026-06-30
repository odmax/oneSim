// OneSim Africa API — JavaScript / Node.js Examples
// Base URL: https://staging.onetelecom.cloud/api/v1 (staging)
//           https://m2m.onetelecom.cloud/api/v1 (production)
// Auth: x-api-key header with your API key

const API_KEY = 'YOUR_API_KEY';
const BASE_URL = 'https://staging.onetelecom.cloud/api/v1';

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...options.headers,
    },
    ...options,
  });
  return response.json();
}

// 1. List available packages
async function listPackages() {
  const data = await api('/packages');
  console.log('Packages:', data.packages);
  return data;
}

// 2. Create a customer
async function createCustomer(name, email, phone, country) {
  const data = await api('/customers', {
    method: 'POST',
    body: JSON.stringify({ name, email, phone, country }),
  });
  return data;
}

// 3. Order an eSIM (with idempotency)
async function orderESIM({ packageId, quantity, customerName, customerEmail, customerPhone, country, idempotencyKey }) {
  const headers = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const data = await api('/esims/order', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      packageId,
      quantity,
      customerName,
      customerEmail,
      customerPhone,
      country,
    }),
  });

  if (data.success) {
    console.log('Order created:', data.order.id);
    console.log('eSIM ICCID:', data.esims[0].iccid);
    console.log('QR Code:', data.esims[0].qrCodeUrl);
  }

  return data;
}

// 4. List orders
async function listOrders(status) {
  const query = status ? `?status=${status}` : '';
  return api(`/orders${query}`);
}

// 5. Get eSIM details
async function getEsim(esimId) {
  return api(`/esims/${esimId}`);
}

// 6. Get eSIM usage
async function getEsimUsage(esimId) {
  return api(`/esims/${esimId}/usage`);
}

// 7. Top-up an eSIM
async function topUpEsim(esimId, packageId, quantity = 1) {
  return api(`/esims/${esimId}/top-up`, {
    method: 'POST',
    body: JSON.stringify({ packageId, quantity }),
  });
}

// 8. Get wallet balance
async function getWallet() {
  return api('/wallet');
}

// 9. Create webhook endpoint
async function createWebhook(name, url, events = ['*']) {
  return api('/webhooks', {
    method: 'POST',
    body: JSON.stringify({ name, url, events }),
  });
}

// 10. Verify API key
async function verifyAuth() {
  return api('/auth/verify');
}

// Example usage:
async function main() {
  // List packages
  const { packages } = await listPackages();
  const pkg = packages[0];

  // Order with idempotency
  const order = await orderESIM({
    packageId: pkg.id,
    quantity: 1,
    customerName: 'John Doe',
    customerEmail: 'john@example.com',
    idempotencyKey: 'my-unique-key-123',
  });

  // Check wallet after purchase
  const wallet = await getWallet();
  console.log('Remaining balance:', wallet.wallet.balance);
}

// Webhook signature verification (Express.js example)
// app.post('/webhooks/onesim', (req, res) => {
//   const signature = req.headers['x-onesim-signature'];
//   const timestamp = req.headers['x-onesim-timestamp'];
//   const payload = JSON.stringify(req.body);
//   const expected = crypto
//     .createHmac('sha256', process.env.WEBHOOK_SECRET)
//     .update(`${timestamp}.${payload}`)
//     .digest('hex');
//   if (signature !== expected) return res.status(401).send('Invalid signature');
//   console.log('Verified webhook:', req.body);
//   res.status(200).send('OK');
// });
