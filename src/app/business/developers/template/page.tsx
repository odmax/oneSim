'use client'

import { useState } from 'react'
import { getAppUrl } from '@/lib/config/urls'

const BASE_URL = `${getAppUrl()}/api/v1`
const JS_FETCH = `// OneSim Business API — JavaScript Integration Example
const ONESIM_API_KEY = 'your_api_key_here';
const BASE_URL = '${BASE_URL}';

async function createESIMOrder() {
  const response = await fetch(\`\${BASE_URL}/esims/order\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${ONESIM_API_KEY}\`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      customerName: 'John Doe',
      customerEmail: 'john@example.com',
      packageId: 'PACKAGE_ID',
      quantity: 1,
    }),
  });
  return response.json();
}

async function getPackages() {
  const response = await fetch(\`\${BASE_URL}/packages\`, {
    headers: { 'Authorization': \`Bearer \${ONESIM_API_KEY}\` },
  });
  return response.json();
}

async function getEsimStatus(esimId) {
  const response = await fetch(\`\${BASE_URL}/esims/\${esimId}\`, {
    headers: { 'Authorization': \`Bearer \${ONESIM_API_KEY}\` },
  });
  return response.json();
}`

const CURL_EXAMPLE = `# List available packages
curl -X GET "${BASE_URL}/packages" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Buy an eSIM
curl -X POST "${BASE_URL}/esims/order" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: unique-request-id-123" \\
  -d '{
    "customerName": "John Doe",
    "customerEmail": "john@example.com",
    "packageId": "PACKAGE_ID",
    "quantity": 1
  }'

# Check eSIM status
curl -X GET "${BASE_URL}/esims/{esimId}" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Get wallet balance
curl -X GET "${BASE_URL}/wallet" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Top up an eSIM
curl -X POST "${BASE_URL}/esims/{esimId}/top-up" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"packageId": "TOPUP_PACKAGE_ID"}'`

const ENV_TEMPLATE = `# OneSim Business API Configuration
ONESIM_API_BASE_URL=${BASE_URL}
ONESIM_API_KEY=your_api_key_here
ONESIM_IDEMPOTENCY_PREFIX=onesim_`

const DOWNLOAD_TEMPLATE = {
  name: 'OneSim Business API Integration',
  version: '1.0.0',
  baseUrl: BASE_URL,
  authentication: {
    type: 'Bearer Token',
    header: 'Authorization: Bearer <ONESIM_API_KEY>',
    idempotency: {
      header: 'Idempotency-Key',
      description: 'Use a unique UUID per order to prevent duplicates. Keys expire after 24 hours.',
    },
  },
  rateLimiting: {
    default: '60 requests per minute per business',
    header: 'X-RateLimit-Limit, X-RateLimit-Remaining',
  },
  endpoints: {
    listPackages: { method: 'GET', path: '/packages' },
    createOrder: { method: 'POST', path: '/esims/order' },
    getEsim: { method: 'GET', path: '/esims/{esimId}' },
    getEsimUsage: { method: 'GET', path: '/esims/{esimId}/usage' },
    listEsims: { method: 'GET', path: '/usage' },
    topUp: { method: 'POST', path: '/esims/{esimId}/top-up' },
    refreshStatus: { method: 'POST', path: '/esims/{esimId}/refresh-status' },
    getOrders: { method: 'GET', path: '/orders' },
    getOrder: { method: 'GET', path: '/orders/{orderId}' },
    getWallet: { method: 'GET', path: '/wallet' },
    getWalletTransactions: { method: 'GET', path: '/wallet/transactions' },
    getCustomers: { method: 'GET', path: '/customers' },
    createCustomer: { method: 'POST', path: '/customers' },
    verifyAuth: { method: 'GET', path: '/auth/verify' },
  },
  examples: {
    orderPayload: {
      customerName: 'John Doe',
      customerEmail: 'john@example.com',
      customerPhone: '+27123456789',
      packageId: 'pkg_example',
      quantity: 1,
    },
    orderResponse: {
      success: true,
      order: { id: 'ord_xxx', status: 'PENDING_ACTIVATION', quantity: 1, unitCost: 5, totalCost: 5, currency: 'USD' },
      esims: [{ id: 'esim_xxx', iccid: '89012345678901234567', activationCode: 'LPA:1$...', qrCodeUrl: 'https://...', status: 'PENDING_ACTIVATION' }],
      wallet: { deducted: 5, currency: 'USD' },
    },
  },
  security: {
    doNotExpose: 'Never expose your API key in frontend code, mobile apps, or public repositories.',
    keyPerSystem: 'Generate one API key per integrating system for traceability.',
    rotateKeys: 'Rotate API keys regularly. Revoke compromised keys immediately via the portal.',
    idempotency: 'Always send an Idempotency-Key header for order creation to prevent duplicate charges.',
  },
}

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative group">
      <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-300 font-mono leading-relaxed">
        {code}
      </pre>
      <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
        className="absolute top-2 right-2 rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

export default function IntegrationTemplatePage() {
  const [copiedEnv, setCopiedEnv] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(DOWNLOAD_TEMPLATE, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'onesim-api-integration-template.json'
    a.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
    setTimeout(() => setDownloaded(false), 3000)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Business API Integration Template</h1>
        <p className="mt-1 text-sm text-gray-500">Ready-to-use template for connecting your systems to OneSim. Copy, paste, and deploy.</p>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <button onClick={handleDownload}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          {downloaded ? '✓ Downloaded' : 'Download Integration Template'}
        </button>
        <button onClick={() => { navigator.clipboard.writeText(ENV_TEMPLATE); setCopiedEnv(true); setTimeout(() => setCopiedEnv(false), 3000) }}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          {copiedEnv ? '✓ Copied' : 'Copy .env Template'}
        </button>
      </div>

      {/* .env Template */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Environment Configuration</h2>
        <p className="text-sm text-gray-500 mb-2">Add these variables to your .env file:</p>
        <CodeBlock code={ENV_TEMPLATE} />
      </section>

      {/* Base URL */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">1. Base URL</h2>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">Staging:</span>
            <code className="rounded bg-gray-200 px-2 py-1 text-sm font-mono">{BASE_URL}</code>
            <CopyButton text={BASE_URL} />
          </div>
          <div className="flex justify-between items-center text-gray-400">
            <span className="text-sm font-medium">Production:</span>
            <code className="text-sm font-mono">https://api.onesim.africa/api/v1</code>
            <span className="text-xs">(configure when live)</span>
          </div>
        </div>
      </section>

      {/* Auth */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">2. Authentication</h2>
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-200 bg-amber-50 p-4 text-sm text-amber-800">
            <strong>Header:</strong> <code>Authorization: Bearer ONESIM_CLIENT_API_KEY</code>
            <p className="mt-1 text-xs">All requests require this header. Get your API key from the <strong>API Keys</strong> page.</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-blue-50 p-4 text-sm text-blue-800">
            <strong>Idempotency:</strong> <code>Idempotency-Key: {"{unique-id}"}</code>
            <p className="mt-1 text-xs">Send a unique UUID per order to prevent duplicate charges. Keys expire after 24 hours.</p>
          </div>
        </div>
      </section>

      {/* Quick Start Flow */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">3. Recommended Integration Flow</h2>
        <div className="space-y-3">
          {[
            { step: '1', title: 'Fetch available packages', desc: 'Call GET /packages to retrieve sellable products', code: `curl -X GET "${BASE_URL}/packages" -H "Authorization: Bearer YOUR_API_KEY"` },
            { step: '2', title: 'Create order with Idempotency-Key', desc: 'POST /esims/order with customer info + packageId', code: `curl -X POST "${BASE_URL}/esims/order" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -d '{"customerName":"John","customerEmail":"john@example.com","packageId":"pkg_id","quantity":1}'` },
            { step: '3', title: 'Store orderId and esimId', desc: 'Save the returned order.id and esims[].id in your system', code: '' },
            { step: '4', title: 'Display QR code to end customer', desc: 'Show the esims[].activationCode or qrCodeUrl to your customer', code: '' },
            { step: '5', title: 'Check activation status', desc: 'Poll GET /esims/{id} or POST /esims/{id}/refresh-status', code: `curl -X GET "${BASE_URL}/esims/{esimId}" -H "Authorization: Bearer YOUR_API_KEY"` },
          ].map(s => (
            <div key={s.step} className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">{s.step}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{s.title}</p>
                <p className="text-xs text-gray-500 mb-2">{s.desc}</p>
                {s.code && <CodeBlock code={s.code} />}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Key Endpoints */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">4. Key Endpoints</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Path</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[
                { m: 'GET', p: '/auth/verify', d: 'Verify API key is valid' },
                { m: 'GET', p: '/packages', d: 'List available eSIM packages' },
                { m: 'POST', p: '/esims/order', d: 'Buy eSIM(s)' },
                { m: 'GET', p: '/esims/{id}', d: 'Get eSIM details + QR code' },
                { m: 'GET', p: '/esims/{id}/usage', d: 'Get eSIM usage records' },
                { m: 'POST', p: '/esims/{id}/refresh-status', d: 'Refresh activation status from provider' },
                { m: 'POST', p: '/esims/{id}/top-up', d: 'Top up existing eSIM' },
                { m: 'GET', p: '/usage', d: 'List all eSIMs with usage summary' },
                { m: 'GET', p: '/orders', d: 'List order history' },
                { m: 'GET', p: '/orders/{id}', d: 'Get single order details' },
                { m: 'GET', p: '/wallet', d: 'Get wallet balance and activity' },
                { m: 'GET', p: '/wallet/transactions', d: 'List wallet transactions' },
                { m: 'GET', p: '/customers', d: 'List customers' },
                { m: 'POST', p: '/customers', d: 'Create a customer' },
              ].map(ep => (
                <tr key={ep.p} className="hover:bg-gray-50">
                  <td className="px-4 py-2"><span className={`font-mono text-xs font-medium ${ep.m === 'GET' ? 'text-emerald-600' : 'text-blue-600'}`}>{ep.m}</span></td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">{ep.p}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{ep.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Code Examples */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">5. Code Examples</h2>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-700">JavaScript / Fetch</h3>
              <CopyButton text={JS_FETCH} />
            </div>
            <CodeBlock code={JS_FETCH} language="javascript" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-700">cURL</h3>
              <CopyButton text={CURL_EXAMPLE} />
            </div>
            <CodeBlock code={CURL_EXAMPLE} />
          </div>
        </div>
      </section>

      {/* Security */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">6. Security Best Practices</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { title: 'Never expose API keys', desc: 'Do not embed API keys in frontend code, mobile apps, or public repositories. Use server-side environment variables.' },
            { title: 'One key per system', desc: 'Generate separate API keys for each integrating system (billing, customer portal, admin panel). Revoke individually if compromised.' },
            { title: 'Use Idempotency-Key', desc: 'Always send a unique UUID in the Idempotency-Key header for order creation. This prevents duplicate charges if the request is retried.' },
            { title: 'Rotate keys regularly', desc: 'Regenerate API keys periodically. Revoke old keys immediately if a security incident occurs.' },
          ].map(s => (
            <div key={s.title} className="rounded-lg border border-gray-200 p-4">
              <p className="text-sm font-medium text-gray-900">{s.title}</p>
              <p className="mt-1 text-xs text-gray-500">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 shrink-0">
      {copied ? '✓' : 'Copy'}
    </button>
  )
}
