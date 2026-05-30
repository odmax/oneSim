'use client'

import { useState, useRef } from 'react'
import { testApiOrder, testVerifyApiKey, testListPackages } from '@/lib/actions/api-test-console'

interface Package {
  id: string
  name: string
  displayName: string | null
  dataGB: number
  validityDays: number
  priceUSD: string
  description: string | null
  customerDescription: string | null
  sku: string | null
  packageCode: string | null
}

interface ApiKey {
  id: string
  name: string
  keyPrefix: string
}

interface Props {
  packages: Package[]
  apiKeys: ApiKey[]
  isAdmin: boolean
  baseUrl: string
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
        className="absolute right-2 top-2 rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="mb-8" id={id}>
      <h3 className="mb-3 text-lg font-semibold text-gray-900">{title}</h3>
      {children}
    </div>
  )
}

function EndpointCard({ method, path, description, children }: { method: string; path: string; description: string; children: React.ReactNode }) {
  const color = method === 'GET' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className={`inline-flex rounded-md px-2.5 py-0.5 text-xs font-bold ${color}`}>{method}</span>
        <code className="text-sm font-mono text-gray-800">{path}</code>
      </div>
      <p className="mb-4 text-sm text-gray-600">{description}</p>
      {children}
    </div>
  )
}

function ParamTable({ params }: { params: Array<{ name: string; type: string; required: boolean; description: string }> }) {
  return (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50">
            <th className="px-4 py-2 text-left font-medium text-gray-600">Field</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Type</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Required</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {params.map(p => (
            <tr key={p.name}>
              <td className="px-4 py-2 font-mono text-xs">{p.name}</td>
              <td className="px-4 py-2">{p.type}</td>
              <td className="px-4 py-2">{p.required ? <span className="text-green-600">Yes</span> : <span className="text-gray-500">No</span>}</td>
              <td className="px-4 py-2 text-gray-600">{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DevelopersClient({ packages, apiKeys, isAdmin, baseUrl }: Props) {
  const [selectedKeyId, setSelectedKeyId] = useState(apiKeys[0]?.id || '')
  const [packageId, setPackageId] = useState(packages[0]?.id || '')
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [country, setCountry] = useState('South Africa')
  const [quantity, setQuantity] = useState(1)
  const [externalCustomerId, setExternalCustomerId] = useState('')
  const [testResult, setTestResult] = useState<any>(null)
  const [testError, setTestError] = useState('')
  const [testLoading, setTestLoading] = useState(false)
  const [generatedCurl, setGeneratedCurl] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  const selectedKey = apiKeys.find(k => k.id === selectedKeyId)
  const selectedPkg = packages.find(p => p.id === packageId)

  const orderParams = [
    { name: 'customerName', type: 'string', required: true, description: 'End customer full name' },
    { name: 'customerEmail', type: 'string', required: true, description: 'End customer email address' },
    { name: 'customerPhone', type: 'string', required: false, description: 'End customer phone number' },
    { name: 'country', type: 'string', required: false, description: 'Customer country' },
    { name: 'packageId', type: 'string', required: false, description: 'Internal package ID (one identifier required)' },
    { name: 'sku', type: 'string', required: false, description: 'Human-readable SKU (e.g. ONESIM-AFRICA-5GB-30D)' },
    { name: 'packageCode', type: 'string', required: false, description: 'Auto-generated package code (e.g. PKG-5GB-30D-X1A)' },
    { name: 'quantity', type: 'integer', required: false, description: 'Number of eSIMs (1-100, default 1)' },
    { name: 'externalCustomerId', type: 'string', required: false, description: 'Your internal customer reference' },
  ]

  async function handleTest(formData: FormData) {
    setTestLoading(true)
    setTestError('')
    setTestResult(null)
    setGeneratedCurl('')

    if (!selectedKeyId) {
      setTestError('Please select an API key')
      setTestLoading(false)
      return
    }

    formData.set('apiKeyPrefix', selectedKey?.keyPrefix || '')

    const result = await testApiOrder(formData)
    if (!result.success) {
      setTestError(result.error || 'Request failed')
    } else {
      setTestResult({ status: result.status, body: result.body })
      if (result.curl) setGeneratedCurl(result.curl)
    }
    setTestLoading(false)
  }

  const successResponse = JSON.stringify({
    success: true,
    order: {
      id: 'cmow...abc123',
      status: 'PENDING_ACTIVATION',
      quantity: 1,
      unitCost: 5.00,
      totalCost: 5.00,
      currency: 'USD',
      createdAt: '2026-05-27T12:00:00.000Z',
    },
    package: {
      id: 'pkg_xxx',
      displayName: 'OneSIM 1GB 7 Days',
      customerDescription: 'Perfect for short trips',
      dataGB: 1,
      validityDays: 7,
      unitCost: 5.00,
      currency: 'USD',
    },
    esims: [{
      id: 'cmow...ghi789',
      iccid: '89012345678901234567',
      imsi: '310150123456789',
      activationCode: 'ABC123',
      qrCodeUrl: 'https://staging.onetelecom.cloud/qr/89012345678901234567',
      status: 'PENDING_ACTIVATION',
      expiresAt: '2026-06-03T12:00:00.000Z',
      activationInstructions: [
        { platform: 'iPhone / iOS', steps: ['Go to Settings → Cellular → Add eSIM', 'Scan the QR code'] },
      ],
    }],
    wallet: { deducted: 5.00, currency: 'USD' },
  }, null, 2)

  const packagesResponse = JSON.stringify({
    success: true,
    packages: [
      { id: 'pkg_xxx', displayName: 'OneSIM 1GB 7 Days', dataGB: 1, validityDays: 7, priceUSD: 5.00, unitCost: 5.00, unitPrice: 5.00, currency: 'USD', customerDescription: 'Perfect for short trips', sku: 'ONESIM-1GB-7D', packageCode: 'PKG-1GB-7D-X1A' },
      { id: 'pkg_yyy', displayName: 'OneSIM 5GB 30 Days', dataGB: 5, validityDays: 30, priceUSD: 15.00, unitCost: 15.00, unitPrice: 15.00, currency: 'USD', customerDescription: 'Ideal for monthly use', sku: 'ONESIM-5GB-30D', packageCode: 'PKG-5GB-30D-Y2B' },
    ],
  }, null, 2)

  const samplePackageId = packages[0]?.id || 'pkg_xxx'

  return (
    <div className="space-y-8">
      {/* Overview */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Overview">
          <p className="mb-3 text-sm text-gray-600">
            The OneSim API lets you order and manage eSIMs from your own systems.
            You send a simple HTTP request — we handle the rest.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-sm font-medium text-gray-700">Base URL</p>
              <code className="mt-1 block text-sm text-blue-600">{baseUrl}/api/v1</code>
            </div>
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-sm font-medium text-gray-700">Auth Method</p>
              <code className="mt-1 block text-sm text-blue-600">Bearer Token (API Key)</code>
            </div>
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-sm font-medium text-gray-700">Content Type</p>
              <code className="mt-1 block text-sm text-blue-600">application/json</code>
            </div>
          </div>

          <p className="mt-4 text-xs text-gray-500">
            All dates and times are in UTC. Monetary values are in USD.
          </p>
        </Section>
      </div>

      {/* ===== DEVELOPER DASHBOARD ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Developer Dashboard">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-xs font-medium text-green-700 uppercase tracking-wider">API Base URL</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="truncate text-sm font-mono font-medium text-green-900">{baseUrl}/api/v1</code>
                <button
                  onClick={() => { navigator.clipboard.writeText(`${baseUrl}/api/v1`); alert('Copied!') }}
                  className="shrink-0 rounded bg-green-200 px-1.5 py-0.5 text-xs text-green-800 hover:bg-green-300"
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-xs font-medium text-blue-700 uppercase tracking-wider">API Keys</p>
              <p className="mt-1 text-2xl font-bold text-blue-900">{apiKeys.length}</p>
              <a href="/business/api-keys" className="mt-1 inline-block text-xs font-medium text-blue-600 hover:text-blue-800 underline">
                Manage Keys →
              </a>
            </div>
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
              <p className="text-xs font-medium text-purple-700 uppercase tracking-wider">Available Packages</p>
              <p className="mt-1 text-2xl font-bold text-purple-900">{packages.length}</p>
            </div>
            <div className="rounded-lg border border-cyan-200 bg-cyan-50 p-4">
              <p className="text-xs font-medium text-cyan-700 uppercase tracking-wider">Auth Method</p>
              <p className="mt-1 text-sm font-mono font-medium text-cyan-900">Bearer Token</p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <p className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Quick Start cURL</p>
            <CodeBlock code={`# 1. Verify your API key
curl -X GET "${baseUrl}/api/v1/auth/verify" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# 2. List available packages
curl -X GET "${baseUrl}/api/v1/packages" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# 3. Place an order
curl -X POST "${baseUrl}/api/v1/esims/order" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-id-123" \\
  -d '{
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "sku": "ONESIM-AFRICA-5GB-30D",
    "quantity": 1
  }'`} />
          </div>

          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Endpoint Status</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { label: 'Auth Verify', path: 'GET /api/v1/auth/verify', ok: true },
                { label: 'List Packages', path: 'GET /api/v1/packages', ok: true },
                { label: 'Place Order', path: 'POST /api/v1/esims/order', ok: true },
                { label: 'Get Order', path: 'GET /api/v1/orders/{orderId}', ok: true },
                { label: 'Get eSIM', path: 'GET /api/v1/esims/{esimId}', ok: true },
                {/* Webhooks — hidden for now */}
              ].map(item => (
                <div key={item.label} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-xs font-medium text-gray-700">{item.label}</span>
                  <span className="ml-auto text-xs font-mono text-gray-400">{item.path}</span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

      {/* ===== QUICK START ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Quick Start: Send Your First API Request">
          <p className="mb-6 text-sm text-gray-600">
            Follow these steps to place your first eSIM order. No coding experience needed — these steps work with cURL (command line) or any API tool.
          </p>

          <div className="space-y-4">
            {/* Step 1 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Create an API Key</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    Go to the <a href="/business/api-keys" className="font-medium text-cyan-600 underline">API Keys</a> page and click <strong>"Create API Key"</strong>.
                    Give it a name like <em>"My App"</em> so you remember what it's for.
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Your key will start with <code className="rounded bg-blue-100 px-1">onesim_</code>.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Copy Your API Key Safely</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    When you create a key, it is shown <strong>only once</strong>. Copy it and store it somewhere safe — like a password manager. You will use it in the next steps.
                  </p>
                  <p className="mt-2 text-xs text-red-600">
                    ⚠ If you lose it, you cannot see it again. Delete and create a new one.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 2.5 */}
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-600 text-sm font-bold text-white">3</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Verify Your API Key</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    Test that your API key is working before placing orders:
                  </p>
                  <div className="mt-2">
                    <CodeBlock code={`curl -X GET "${baseUrl}/api/v1/auth/verify" \\
  -H "Authorization: Bearer YOUR_API_KEY"`} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    A successful response returns <code className="rounded bg-green-100 px-1">{JSON.stringify({ success: true, businessId: 'bus_xxx' })}</code>.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 4 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">4</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Choose an Active eSIM Package</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    Each eSIM plan has a <strong>packageId</strong> — a unique ID that tells us which plan to order.
                    You can list all available packages by calling:
                  </p>
                  <div className="mt-2">
                    <CodeBlock code={`curl -X GET "${baseUrl}/api/v1/packages" \
  -H "Authorization: Bearer YOUR_API_KEY"`} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Pick a <code className="rounded bg-blue-100 px-1">packageId</code> from the response. In this guide we will use <code className="rounded bg-blue-100 px-1">{samplePackageId}</code>.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 5 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">5</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Prepare Customer Details</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    You need at least a <strong>name</strong> and <strong>email</strong> for the person who will receive the eSIM. A phone number is optional but helpful.
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Example: Name = "Jane Smith", Email = "jane@example.com", Country = "South Africa"
                  </p>
                </div>
              </div>
            </div>

            {/* Step 6 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">6</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Send the API Request</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    Send a <strong>POST</strong> request to <code className="rounded bg-blue-100 px-1">/api/v1/esims/order</code> with the customer details and package ID.
                  </p>
                  <p className="mt-2 text-sm font-medium text-gray-700">cURL (command line):</p>
                  <CodeBlock code={`# Using packageId (traditional)
curl -X POST "${baseUrl}/api/v1/esims/order" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-id-123" \
  -d '{
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "+27123456789",
    "country": "South Africa",
    "packageId": "${samplePackageId}",
    "quantity": 1
  }'

# Using SKU (simpler, human-readable)
curl -X POST "${baseUrl}/api/v1/esims/order" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-id-456" \
  -d '{
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "+27123456789",
    "country": "South Africa",
    "sku": "ONESIM-AFRICA-5GB-30D",
    "quantity": 1
  }'`} />

                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-cyan-600 hover:text-cyan-800">JavaScript (fetch) — click to expand</summary>
                    <div className="mt-2">
                      <CodeBlock code={`const response = await fetch("${baseUrl}/api/v1/esims/order", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
    "Idempotency-Key": "my-unique-id-123",
  },
  body: JSON.stringify({
    customerName: "Jane Smith",
    customerEmail: "jane@example.com",
    customerPhone: "+27123456789",
    country: "South Africa",
    packageId: "${samplePackageId}",
    quantity: 1,
  }),
});
const data = await response.json();
console.log(data);`} />
                    </div>
                  </details>

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-cyan-600 hover:text-cyan-800">Postman — click to expand</summary>
                    <div className="mt-3 space-y-2 text-xs text-gray-600">
                      <p><strong>1.</strong> Create a new request in Postman.</p>
                      <p><strong>2.</strong> Set method to <code className="rounded bg-gray-200 px-1">POST</code> and URL to <code className="rounded bg-gray-200 px-1">{baseUrl}/api/v1/esims/order</code>.</p>
                      <p><strong>3.</strong> Go to <strong>Headers</strong> tab and add:</p>
                      <div className="rounded-lg bg-gray-100 p-2 font-mono text-xs">
                        <p>Authorization: Bearer YOUR_API_KEY</p>
                        <p>Content-Type: application/json</p>
                        <p>Idempotency-Key: my-unique-id-123</p>
                      </div>
                      <p><strong>4.</strong> Go to <strong>Body</strong> tab → <strong>raw</strong> (JSON) and paste:</p>
                      <div className="rounded-lg bg-gray-100 p-2 font-mono text-xs">
                        <p>{'{'}</p>
                        <p>&nbsp;&nbsp;"customerName": "Jane Smith",</p>
                        <p>&nbsp;&nbsp;"customerEmail": "jane@example.com",</p>
                        <p>&nbsp;&nbsp;"customerPhone": "+27123456789",</p>
                        <p>&nbsp;&nbsp;"country": "South Africa",</p>
                        <p>&nbsp;&nbsp;"packageId": "{samplePackageId}",</p>
                        <p>&nbsp;&nbsp;"quantity": 1</p>
                        <p>{'}'}</p>
                      </div>
                      <p><strong>5.</strong> Click <strong>Send</strong>. You should get a <strong>200 OK</strong> response.</p>
                    </div>
                  </details>
                </div>
              </div>
            </div>

            {/* Step 7 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">7</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Read the Response</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    A successful response includes an <strong>orderId</strong>, <strong>customerId</strong>, and a list of <strong>esims</strong> with their unique ICCID (the eSIM serial number).
                  </p>
                  <CodeBlock code={successResponse} />
                  <div className="mt-3 space-y-2 text-xs text-gray-600">
                    <p><code className="rounded bg-gray-100 px-1 font-mono">orderId</code> — Your order reference. Use it to check status later.</p>
                    <p><code className="rounded bg-gray-100 px-1 font-mono">customerId</code> — The unique ID for this customer in our system.</p>
                    <p><code className="rounded bg-gray-100 px-1 font-mono">esims[].id</code> — The eSIM record ID.</p>
                    <p><code className="rounded bg-gray-100 px-1 font-mono">esims[].iccid</code> — The eSIM's serial number. Used to download the profile.</p>
                    <p><code className="rounded bg-gray-100 px-1 font-mono">esims[].status</code> — Shows <strong>PENDING_ACTIVATION</strong>. It becomes <strong>ACTIVE</strong> once ready.</p>
                    <p><code className="rounded bg-gray-100 px-1 font-mono">esims[].qrCodeUrl</code> — A URL to the QR code for installing the eSIM profile.</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 8 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">8</span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-gray-900">Track Order / eSIM Status</h4>
                  <p className="mt-1 text-sm text-gray-600">
                    Check whether your order or eSIM has been activated:
                  </p>
                  <div className="mt-2 space-y-2">
                    <div>
                      <p className="text-xs font-medium text-gray-700">Get order status:</p>
                      <CodeBlock code={`curl -X GET "${baseUrl}/api/v1/orders/{orderId}" \
  -H "Authorization: Bearer YOUR_API_KEY"`} />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-gray-700">Get eSIM status:</p>
                      <CodeBlock code={`curl -X GET "${baseUrl}/api/v1/esims/{esimId}/status" \
  -H "Authorization: Bearer YOUR_API_KEY"`} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Webhooks step — hidden for now */}
          </div>
        </Section>
      </div>

      {/* ===== FIELD EXPLANATIONS ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Understanding the Fields">
          <p className="mb-4 text-sm text-gray-600">
            Here is what each field means in plain English:
          </p>
          <div className="space-y-3">
            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                <code className="rounded bg-gray-100 px-1 font-mono">Authorization</code> Header
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                This is how you prove who you are. Every request must include your API key in an <code className="rounded bg-gray-100 px-1">Authorization</code> header.
                Format: <code className="rounded bg-gray-100 px-1">Authorization: Bearer YOUR_API_KEY</code>.
                Replace <code className="rounded bg-gray-100 px-1">YOUR_API_KEY</code> with the key you created in Step 1.
              </p>
            </div>

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                <code className="rounded bg-gray-100 px-1 font-mono">Idempotency-Key</code> Header
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                A unique ID for each request to prevent duplicate orders. If your network fails and you retry, using the same key ensures the order is only processed once.
                Use anything unique: a UUID, your database record ID, or <code className="rounded bg-gray-100 px-1">order-{'{yourOrderNumber}'}</code>.
                The key is valid for 24 hours.
              </p>
            </div>

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Package Identifiers
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                You can identify a package using any of the following fields. Only one is required.
                They are resolved in this priority: <code className="rounded bg-gray-100 px-1 font-mono">packageId</code> → <code className="rounded bg-gray-100 px-1 font-mono">sku</code> → <code className="rounded bg-gray-100 px-1 font-mono">packageCode</code>.
              </p>
              <div className="mt-3 space-y-2 text-sm text-gray-600">
                <p><code className="rounded bg-gray-100 px-1 font-mono">packageId</code> — Internal OneSim package ID (e.g. <code className="rounded bg-gray-100 px-1">cmow...abc123</code>). Get it from <code className="rounded bg-gray-100 px-1">GET /api/v1/packages</code>.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">sku</code> — Human-readable stock keeping unit (e.g. <code className="rounded bg-gray-100 px-1">ONESIM-AFRICA-5GB-30D</code>). Easy to remember and share.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">packageCode</code> — Short auto-generated code (e.g. <code className="rounded bg-gray-100 px-1">PKG-5GB-30D-X1A2B3C</code>).</p>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Pricing Fields
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                Every package and order response includes the OneSim client price. You may add your own markup on your platform.
              </p>
              <div className="mt-2 space-y-2 text-sm text-gray-600">
                <p><code className="rounded bg-gray-100 px-1 font-mono">unitCost</code> / <code className="rounded bg-gray-100 px-1 font-mono">unitPrice</code> — The OneSim price per eSIM (maps from <code className="rounded bg-gray-100 px-1">priceUSD</code>). This is your cost.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">totalCost</code> — <code className="rounded bg-gray-100 px-1">unitCost × quantity</code>. The total charged to your wallet.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">quantity</code> — Number of eSIMs purchased in this order.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">currency</code> — Always <code className="rounded bg-gray-100 px-1">USD</code>.</p>
                <p className="mt-2 text-xs text-gray-400"><strong>Note:</strong> <code className="rounded bg-gray-100 px-1">unitCost</code> is the OneSim client price. You may set a higher <code className="rounded bg-gray-100 px-1">suggestedRetailPrice</code> on your platform.</p>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Package Display Fields
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                The <code className="rounded bg-gray-100 px-1">GET /api/v1/packages</code> endpoint returns customer-friendly names:
              </p>
              <div className="mt-2 space-y-2 text-sm text-gray-600">
                <p><code className="rounded bg-gray-100 px-1 font-mono">displayName</code> — Customer-facing package name (e.g. <em>OneSIM 5GB 30 Days</em>). Use this in your UI.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">customerDescription</code> — Short description written for end customers.</p>
                <p><code className="rounded bg-gray-100 px-1 font-mono">name</code> — Internal admin name. Not intended for customer display.</p>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Customer Fields <code className="rounded bg-gray-100 px-1 font-mono">customerName</code>, <code className="rounded bg-gray-100 px-1 font-mono">customerEmail</code>, <code className="rounded bg-gray-100 px-1 font-mono">customerPhone</code>, <code className="rounded bg-gray-100 px-1 font-mono">country</code>
              </h4>
              <p className="mt-1 text-sm text-gray-600">
                These are the details of the <strong>end user</strong> — the person who will receive and use the eSIM.
                <code className="rounded bg-gray-100 px-1">customerName</code> and <code className="rounded bg-gray-100 px-1">customerEmail</code> are required.
                <code className="rounded bg-gray-100 px-1">customerPhone</code> is useful if you want to send setup instructions via SMS.
                <code className="rounded bg-gray-100 px-1">country</code> helps us select the right network configuration.
              </p>
            </div>

            {/* callbackUrl — hidden for now */}

            <div className="rounded-lg border p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Status Values
              </h4>
              <div className="mt-2 space-y-2 text-sm text-gray-600">
                <p><span className="inline-flex rounded-full bg-yellow-100 px-2 text-xs font-semibold text-yellow-800">PENDING_ACTIVATION</span> — Order received. Awaiting activation by carrier network.</p>
                <p><span className="inline-flex rounded-full bg-green-100 px-2 text-xs font-semibold text-green-800">ACTIVE</span> — eSIM is ready to use. Download the profile using the QR code or install code.</p>
                <p><span className="inline-flex rounded-full bg-red-100 px-2 text-xs font-semibold text-red-800">FAILED</span> — Something went wrong. No charge was made. Contact support or try again.</p>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* ===== AUTHENTICATION ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Authentication">
          <p className="mb-3 text-sm text-gray-600">
            Every API request must include your API key in the <code className="rounded bg-gray-100 px-1">Authorization</code> header.
            You manage keys in the <a href="/business/api-keys" className="font-medium text-cyan-600 underline">API Keys</a> page.
          </p>
          <CodeBlock code={`Authorization: Bearer YOUR_API_KEY`} />
          <p className="mt-3 text-xs text-gray-500">
            Replace <code className="rounded bg-gray-100 px-1">YOUR_API_KEY</code> with your actual key.
            Keys start with <code className="rounded bg-gray-100 px-1">onesim_</code> and are shown only once when created.
          </p>
        </Section>
      </div>

      {/* ===== API ENDPOINTS ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="API Endpoints">

          {/* Auth Verify */}
          <EndpointCard method="GET" path="/api/v1/auth/verify" description="Verify your API key is valid and return your business ID.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={JSON.stringify({ success: true, businessId: 'bus_xxx' }, null, 2)} />
          </EndpointCard>

          {/* Packages */}
          <EndpointCard method="GET" path="/api/v1/packages" description="List all active eSIM packages with pricing and details.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={packagesResponse} />
          </EndpointCard>

          {/* Order */}
          <EndpointCard method="POST" path="/api/v1/esims/order" description="Create a new eSIM order. The request is routed to the appropriate carrier network based on the package configuration.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Request Body</h5>
            <ParamTable params={orderParams} />
            <h5 className="mb-2 mt-5 text-xs font-semibold text-gray-700 uppercase tracking-wider">Success Response (200)</h5>
            <CodeBlock code={successResponse} />
            <h5 className="mb-2 mt-5 text-xs font-semibold text-gray-700 uppercase tracking-wider">Error Responses</h5>
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">400 — Validation Error</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'MISSING_FIELDS', message: 'customerName and customerEmail are required' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">401 — Authentication Error</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'AUTH_FAILED', message: 'Missing or invalid Authorization header.' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">402 — Insufficient Balance</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'INSUFFICIENT_WALLET_BALANCE', message: 'Insufficient wallet balance. Please request credit before ordering.' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">403 — Suspended Business</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'BUSINESS_SUSPENDED', message: 'Business account is suspended.' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">404 — Package Not Found</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'PACKAGE_UNAVAILABLE', message: 'This package is no longer available.' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">429 — Rate Limit Exceeded</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please reduce request volume and retry after 60 seconds.' } }, null, 2)} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-red-600">502 — Provider Error</p>
                <CodeBlock code={JSON.stringify({ success: false, error: { code: 'PROVIDER_PROVISIONING_FAILED', message: 'Provider could not provision this eSIM right now.' } }, null, 2)} />
              </div>
            </div>

            <h5 className="mb-2 mt-5 text-xs font-semibold text-gray-700 uppercase tracking-wider">Idempotency-Key</h5>
            <p className="mb-2 text-sm text-gray-600">
              Include an <code className="rounded bg-gray-100 px-1">Idempotency-Key</code> header to prevent duplicate orders.
              If the same key is reused within 24 hours, the original response is returned without processing a new order.
            </p>
            <CodeBlock code={`Idempotency-Key: unique-request-id-123`} />
          </EndpointCard>

          {/* Order Status */}
          <EndpointCard method="GET" path="/api/v1/orders/{orderId}" description="Get the status of a specific order including all eSIMs in that order.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Path Parameters</h5>
            <ParamTable params={[
              { name: 'orderId', type: 'string', required: true, description: 'Order ID returned from POST /api/v1/esims/order' },
            ]} />
            <h5 className="mb-2 mt-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={JSON.stringify({
              success: true,
              order: {
                id: 'cmow...abc123',
                status: 'PENDING_ACTIVATION',
                quantity: 1,
                unitCost: 5.00,
                totalCost: 5.00,
                currency: 'USD',
                createdAt: '2026-05-09T12:00:00Z',
                package: { id: 'pkg_xxx', displayName: 'OneSIM 1GB 7 Days', dataGB: 1, validityDays: 7, unitCost: 5.00, currency: 'USD' },
                esims: [{ id: 'cmow...ghi789', iccid: '89012345678901234567', imsi: null, activationCode: null, status: 'PENDING_ACTIVATION', qrCodeUrl: null }],
                wallet: { deducted: 5.00, currency: 'USD' },
              },
            }, null, 2)} />
          </EndpointCard>

          {/* eSIM Status */}
          <EndpointCard method="GET" path="/api/v1/esims/{esimId}/status" description="Get the current status and details for a specific eSIM.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Path Parameters</h5>
            <ParamTable params={[
              { name: 'esimId', type: 'string', required: true, description: 'eSIM ID returned from order creation' },
            ]} />
            <h5 className="mb-2 mt-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={JSON.stringify({
              success: true,
              esim: {
                id: 'cmow...ghi789',
                iccid: '89012345678901234567',
                status: 'ACTIVE',
                qrCodeUrl: 'https://staging.onetelecom.cloud/qr/89012345678901234567',
                activationCode: null,
                imsi: '310150123456789',
                expiresAt: '2026-05-16T12:00:00Z',
                package: { id: 'pkg_xxx', displayName: 'OneSIM 1GB 7 Days', dataGB: 1, validityDays: 7, priceUSD: 5.00, unitCost: 5.00, currency: 'USD' },
                dataUsedMB: 0,
                usageRecords: [],
                activationInstructions: [
                  { platform: 'iPhone / iOS', steps: ['Go to Settings → Cellular → Add eSIM', 'Scan the QR code'] },
                  { platform: 'Android', steps: ['Go to Settings → Network → Mobile Network → Add Carrier', 'Scan the QR code'] },
                ],
              },
            }, null, 2)} />
          </EndpointCard>

          {/* Customers */}
          <EndpointCard method="GET" path="/api/v1/customers" description="List all customers registered under your business.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Query Parameters</h5>
            <ParamTable params={[
              { name: 'search', type: 'string', required: false, description: 'Search by name or email' },
              { name: 'page', type: 'integer', required: false, description: 'Page number (default 1)' },
              { name: 'limit', type: 'integer', required: false, description: 'Results per page (default 20, max 100)' },
            ]} />
            <h5 className="mb-2 mt-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={JSON.stringify({
              success: true,
              customers: [
                { id: 'cmow...cust1', name: 'John Doe', email: 'john@example.com', phone: '+27123456789', country: 'South Africa', esimCount: 2, createdAt: '2026-05-01T10:00:00Z' },
              ],
              total: 1,
              page: 1,
              limit: 20,
            }, null, 2)} />
          </EndpointCard>

          {/* Orders List */}
          <EndpointCard method="GET" path="/api/v1/orders" description="List all orders placed by your business.">
            <h5 className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">Query Parameters</h5>
            <ParamTable params={[
              { name: 'status', type: 'string', required: false, description: 'Filter by status: PENDING_ACTIVATION, ACTIVE, FAILED' },
              { name: 'page', type: 'integer', required: false, description: 'Page number (default 1)' },
              { name: 'limit', type: 'integer', required: false, description: 'Results per page (default 20, max 100)' },
            ]} />
            <h5 className="mb-2 mt-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Response</h5>
            <CodeBlock code={JSON.stringify({
              success: true,
              orders: [
                {
                  id: 'cmow...abc123',
                  status: 'PENDING_ACTIVATION',
                  quantity: 1,
                  unitCost: 5.00,
                  totalCost: 5.00,
                  currency: 'USD',
                  createdAt: '2026-05-09T12:00:00Z',
                  package: { id: 'pkg_xxx', displayName: 'OneSIM 1GB 7 Days', dataGB: 1, validityDays: 7, unitCost: 5.00, currency: 'USD' },
                  esims: [{ id: 'cmow...ghi789', iccid: '89012345678901234567', status: 'PENDING_ACTIVATION' }],
                },
              ],
            }, null, 2)} />
          </EndpointCard>
        </Section>

        <Section title="Order Status Values">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr><td className="px-4 py-2"><span className="inline-flex rounded-full bg-yellow-100 px-2 text-xs font-semibold text-yellow-800">PENDING_ACTIVATION</span></td><td className="px-4 py-2 text-gray-600">Order created, activation in progress</td></tr>
                <tr><td className="px-4 py-2"><span className="inline-flex rounded-full bg-green-100 px-2 text-xs font-semibold text-green-800">ACTIVE</span></td><td className="px-4 py-2 text-gray-600">eSIM activated and ready to use</td></tr>
                <tr><td className="px-4 py-2"><span className="inline-flex rounded-full bg-red-100 px-2 text-xs font-semibold text-red-800">FAILED</span></td><td className="px-4 py-2 text-gray-600">Activation failed, no wallet charge</td></tr>
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      {/* ===== TROUBLESHOOTING ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Troubleshooting">
          <p className="mb-4 text-sm text-gray-600">
            If your request does not work the way you expect, here is what to check for each type of error:
          </p>

          <div className="space-y-4">
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-bold text-red-800">
                <span className="inline-flex items-center rounded bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">401</span>
                {' '}Invalid API Key
              </h4>
              <p className="mt-1 text-sm text-red-700">
                <strong>What it means:</strong> Your API key is missing, expired, or typed incorrectly.
              </p>
              <ul className="mt-1 list-inside list-disc text-sm text-red-700">
                <li>Make sure you included the <code className="rounded bg-red-100 px-1">Authorization: Bearer YOUR_KEY</code> header.</li>
                <li>Check that the key still starts with <code className="rounded bg-red-100 px-1">onesim_</code> and has no extra spaces.</li>
                <li>Go to <a href="/business/api-keys" className="font-medium underline">API Keys</a> and verify the key is active and not deleted.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-bold text-red-800">
                <span className="inline-flex items-center rounded bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">403</span>
                {' '}Business Not Approved / Suspended
              </h4>
              <p className="mt-1 text-sm text-red-700">
                <strong>What it means:</strong> Your business account is not active or has been suspended.
              </p>
              <ul className="mt-1 list-inside list-disc text-sm text-red-700">
                <li>Check your business status on the <a href="/business/profile" className="font-medium underline">Profile</a> page.</li>
                <li>Contact support if your account should be active but is not.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-bold text-red-800">
                <span className="inline-flex items-center rounded bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">400</span>
                {' '}Missing or Invalid Fields
              </h4>
              <p className="mt-1 text-sm text-red-700">
                <strong>What it means:</strong> One or more required fields are missing or have invalid values.
              </p>
              <ul className="mt-1 list-inside list-disc text-sm text-red-700">
                <li>Make sure you included <code className="rounded bg-red-100 px-1">customerName</code> and <code className="rounded bg-red-100 px-1">customerEmail</code> in the request body.</li>
                <li>Provide at least one package identifier: <code className="rounded bg-red-100 px-1">packageId</code>, <code className="rounded bg-red-100 px-1">sku</code>, or <code className="rounded bg-red-100 px-1">packageCode</code>.</li>
                <li>Check that the identifier resolves to an active package (call <code className="rounded bg-red-100 px-1">GET /api/v1/packages</code> to list available options).</li>
                <li>Ensure <code className="rounded bg-red-100 px-1">quantity</code> is a number between 1 and 100.</li>
                <li>Make sure your JSON is valid — no trailing commas, quotes balanced.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-bold text-red-800">
                <span className="inline-flex items-center rounded bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">429</span>
                {' '}Rate Limit Exceeded
              </h4>
              <p className="mt-1 text-sm text-red-700">
                <strong>What it means:</strong> You sent too many requests in a short time. The rate limit is 60 requests per minute per business.
              </p>
              <ul className="mt-1 list-inside list-disc text-sm text-red-700">
                <li>Wait for the time specified in the <code className="rounded bg-red-100 px-1">Retry-After</code> response header before sending more requests.</li>
                <li>If you need a higher limit, contact support to have it adjusted.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-bold text-red-800">
                <span className="inline-flex items-center rounded bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">500 / 502</span>
                {' '}Server Error
              </h4>
              <p className="mt-1 text-sm text-red-700">
                <strong>What it means:</strong> Something went wrong on our side. Your wallet was not charged.
              </p>
              <ul className="mt-1 list-inside list-disc text-sm text-red-700">
                <li>Wait a few minutes and retry with the same <code className="rounded bg-red-100 px-1">Idempotency-Key</code> (it will not create a duplicate).</li>
                <li>If the error persists, contact support with your <code className="rounded bg-red-100 px-1">orderId</code> or <code className="rounded bg-red-100 px-1">Idempotency-Key</code>.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
              <h4 className="text-sm font-bold text-yellow-800">General Tips</h4>
              <ul className="mt-1 list-inside list-disc text-sm text-yellow-700">
                <li>Use the <strong>Test Console</strong> below to try a request with your admin session before calling via API.</li>
                <li>Always include an <code className="rounded bg-yellow-100 px-1">Idempotency-Key</code> to prevent duplicate charges from retries.</li>
                <li>If you are using Postman, check that you are sending <code className="rounded bg-yellow-100 px-1">raw</code> JSON body (not form-data).</li>
                <li>Check your wallet balance — 402 errors mean insufficient funds.</li>
              </ul>
            </div>
          </div>
        </Section>
      </div>

      {/* ===== CODE EXAMPLES ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Code Examples">
          <p className="mb-4 text-sm text-gray-600">
            Ready-to-use code snippets. Replace <code className="rounded bg-gray-100 px-1">YOUR_API_KEY</code> with your actual API key and copy-paste.
          </p>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">cURL — Place an Order</h4>
            <p className="mb-2 text-xs text-gray-500">Works on any machine with curl installed (Mac, Linux, Windows). Use <code className="rounded bg-gray-100 px-1">sku</code> or <code className="rounded bg-gray-100 px-1">packageId</code>.</p>
            <CodeBlock code={`# Using SKU (recommended for integrations)
curl -X POST ${baseUrl}/api/v1/esims/order \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: unique-request-id-123" \\
  -d '{
  "customerName": "Jane Smith",
  "customerEmail": "jane@example.com",
  "customerPhone": "+27123456789",
  "country": "South Africa",
  "sku": "ONESIM-AFRICA-5GB-30D",
  "quantity": 1
}'`} lang="bash" />
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">cURL — List Packages</h4>
            <CodeBlock code={`curl -X GET ${baseUrl}/api/v1/packages \\
  -H "Authorization: Bearer YOUR_API_KEY"`} lang="bash" />
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">JavaScript (fetch) — Place an Order</h4>
            <p className="mb-2 text-xs text-gray-500">Works in browsers, Node.js 18+, Deno, Bun.</p>
            <CodeBlock code={`// Using SKU for readability — packageId or packageCode also work
const response = await fetch("${baseUrl}/api/v1/esims/order", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
    "Idempotency-Key": "unique-request-id-123",
  },
  body: JSON.stringify({
    customerName: "Jane Smith",
    customerEmail: "jane@example.com",
    customerPhone: "+27123456789",
    country: "South Africa",
    sku: "ONESIM-AFRICA-5GB-30D",
    quantity: 1,
  }),
});

const data = await response.json();
console.log("Status:", response.status);
console.log("Response:", data);`} lang="javascript" />
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">Node.js (axios)</h4>
            <p className="mb-2 text-xs text-gray-500">If you use axios in your Node.js project.</p>
            <CodeBlock code={`import axios from "axios";

const response = await axios.post(
  "${baseUrl}/api/v1/esims/order",
  {
    customerName: "Jane Smith",
    customerEmail: "jane@example.com",
    customerPhone: "+27123456789",
    country: "South Africa",
    packageId: "${samplePackageId}",
    quantity: 1,
  },
  {
    headers: {
      Authorization: "Bearer YOUR_API_KEY",
      "Content-Type": "application/json",
      "Idempotency-Key": "unique-request-id-123",
    },
  }
);

console.log("Status:", response.status);
console.log("Response:", response.data);`} lang="javascript" />
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">Python</h4>
            <p className="mb-2 text-xs text-gray-500">Plain Python 3 with the built-in <code className="rounded bg-gray-100 px-1">urllib</code> library.</p>
            <CodeBlock code={`import json
import urllib.request

url = "${baseUrl}/api/v1/esims/order"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
    "Idempotency-Key": "unique-request-id-123",
}
body = json.dumps({
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "+27123456789",
    "country": "South Africa",
    "sku": "ONESIM-AFRICA-5GB-30D",  # or packageId, packageCode
    "quantity": 1,
}).encode("utf-8")

req = urllib.request.Request(url, data=body, headers=headers, method="POST")
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())
    print("Status:", resp.status)
    print("Response:", data)`} lang="python" />
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">No-Code / Low-Code Tools</h4>
            <p className="mb-2 text-sm text-gray-600">
              You do not need to write code to use the OneSim API. These tools let you send HTTP requests visually:
            </p>
            <div className="space-y-2 text-sm text-gray-600">
              <div className="rounded-lg border p-3">
                <p className="font-medium text-gray-900">Postman</p>
                <p className="text-gray-600">Free desktop app. Create a POST request, set the URL, add headers and body, click Send. See the expanded instructions in Step 5 above.</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium text-gray-900">Make.com (formerly Integromat)</p>
                <p className="text-gray-600">Use the "HTTP – Make a request" module. Set method to POST, enter URL, add headers (Authorization, Content-Type, Idempotency-Key), and paste the JSON body.</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium text-gray-900">n8n / Zapier</p>
                <p className="text-gray-600">Use the "Webhook" or "HTTP Request" node. Configure the same way: POST method, URL, headers, and JSON body.</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium text-gray-900">Thunder Client (VS Code)</p>
                <p className="text-gray-600">VS Code extension. Create a new request, select POST, enter URL, add headers, paste JSON body, click Send.</p>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* ===== RATE LIMITING ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Rate Limiting">
          <p className="mb-3 text-sm text-gray-600">
            API requests are rate-limited to protect the platform from excessive traffic.
            Limits are applied per business on a rolling 60-second window.
          </p>
          <div className="mb-4 space-y-3">
            <div className="rounded-lg bg-blue-50 p-4">
              <p className="text-sm font-medium text-gray-900">Default Rate Limit</p>
              <p className="text-sm text-gray-600">
                60 requests per minute per business. This can be adjusted per business
                by an admin in the business settings.
              </p>
            </div>
            <div className="rounded-lg bg-yellow-50 p-4">
              <p className="text-sm font-medium text-gray-900">Rate Limit Headers</p>
              <p className="text-sm text-gray-600">
                Every response includes <code className="rounded bg-gray-200 px-1">X-RateLimit-Limit</code> and{' '}
                <code className="rounded bg-gray-200 px-1">X-RateLimit-Remaining</code> headers
                so you can track your current usage programmatically.
              </p>
            </div>
          </div>
        </Section>
      </div>

      {/* ===== TEST CONSOLE ===== */}
      <div className="rounded-lg border bg-white p-6">
        <Section title="Test Console">
          <p className="mb-4 text-sm text-gray-600">
            Test the OneSim API from your browser. Quick actions run against the live API using your session.
          </p>

          {apiKeys.length === 0 && (
            <div className="mb-4 rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800">
              No active API keys found.{' '}
              {isAdmin ? (
                <a href="/business/api-keys" className="font-medium text-yellow-900 underline">Create one on the API Keys page →</a>
              ) : (
                'Ask your Business Admin to create one.'
              )}
            </div>
          )}

          {/* Quick Actions */}
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <button
              onClick={async () => {
                setTestLoading(true)
                setTestError('')
                setTestResult(null)
                try {
                  const result = await testVerifyApiKey()
                  setTestResult({
                    status: result.success ? 200 : 400,
                    body: result,
                    action: 'verify',
                  })
                } catch (e: any) {
                  setTestError(e.message)
                }
                setTestLoading(false)
              }}
              className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 hover:bg-green-100"
              disabled={testLoading}
            >
              Verify API Key
            </button>
            <button
              onClick={async () => {
                setTestLoading(true)
                setTestError('')
                setTestResult(null)
                try {
                  const result = await testListPackages()
                  setTestResult({
                    status: result.success ? 200 : 400,
                    body: result,
                    action: 'packages',
                  })
                } catch (e: any) {
                  setTestError(e.message)
                }
                setTestLoading(false)
              }}
              className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-sm font-medium text-purple-700 hover:bg-purple-100"
              disabled={testLoading}
            >
              List Packages
            </button>
            <button
              onClick={() => {
                if (apiKeys.length > 0) {
                  setTestResult(null)
                  setTestError('')
                  formRef.current?.scrollIntoView({ behavior: 'smooth' })
                }
              }}
              className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 hover:bg-blue-100"
            >
              Place Test Order ↓
            </button>
          </div>

          <div className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-700">
            Quick actions use your browser session (not an API key). The full external flow with rate limiting and request logging is only triggered when using a real API key via cURL against <code className="rounded bg-blue-100 px-1">/api/v1/esims/order</code>.
          </div>

          <form ref={formRef} action={handleTest} className="space-y-4">
            <input type="hidden" name="packageId" value={packageId} />
            <input type="hidden" name="quantity" value={quantity} />
            <input type="hidden" name="sku" value="" />
            <input type="hidden" name="packageCode" value="" />
            <input type="hidden" name="externalCustomerId" value={externalCustomerId} />

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">API Key (for cURL generation)</label>
                <select
                  value={selectedKeyId}
                  onChange={e => setSelectedKeyId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                >
                  <option value="">Select a key...</option>
                  {apiKeys.map(k => (
                    <option key={k.id} value={k.id}>{k.name} ({k.keyPrefix}...)</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Package</label>
                <select
                  value={packageId}
                  onChange={e => setPackageId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                >
                  <option value="">Select a package...</option>
                  {packages.map(p => (
                    <option key={p.id} value={p.id}>{p.displayName || p.name} (${p.priceUSD})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Customer Name *</label>
                <input
                  type="text"
                  name="customerName"
                  value={customerName}
                  onChange={e => setCustomerName(e.target.value)}
                  placeholder="e.g. Jane Smith"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Customer Email *</label>
                <input
                  type="email"
                  name="customerEmail"
                  value={customerEmail}
                  onChange={e => setCustomerEmail(e.target.value)}
                  placeholder="e.g. jane@example.com"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Customer Phone</label>
                <input
                  type="text"
                  name="customerPhone"
                  value={customerPhone}
                  onChange={e => setCustomerPhone(e.target.value)}
                  placeholder="e.g. +27123456789"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
                <input
                  type="text"
                  name="country"
                  value={country}
                  onChange={e => setCountry(e.target.value)}
                  placeholder="e.g. South Africa"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={quantity}
                  onChange={e => setQuantity(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">External Customer ID</label>
                <input
                  type="text"
                  value={externalCustomerId}
                  onChange={e => setExternalCustomerId(e.target.value)}
                  placeholder="Your internal reference"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={testLoading || apiKeys.length === 0 || !packageId || !customerName || !customerEmail}
                className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
              >
                {testLoading ? 'Processing...' : 'Place Test Order'}
              </button>
              {testResult && (
                <span className={`text-sm font-medium ${testResult.status < 400 ? 'text-green-600' : 'text-red-600'}`}>
                  Status: {testResult.status}
                </span>
              )}
            </div>
          </form>

          {testError && (
            <div className="mt-4 rounded-lg bg-red-50 p-4">
              <p className="text-sm text-red-800">{testError}</p>
            </div>
          )}

          {generatedCurl && (
            <div className="mt-6">
              <h4 className="mb-2 text-sm font-semibold text-gray-700">Generated cURL Command</h4>
              <p className="mb-2 text-xs text-gray-500">Use this from your terminal to test the external API:</p>
              <CodeBlock code={generatedCurl} lang="bash" />
            </div>
          )}

          {testResult && (
            <div className="mt-4">
              <h4 className="mb-2 text-sm font-semibold text-gray-700">
                {testResult.action === 'verify' ? 'Verify Key Response' :
                 testResult.action === 'packages' ? 'List Packages Response' :
                 'Order Response'}
                <span className="ml-2 text-xs text-gray-500">Status: {testResult.status}</span>
              </h4>
              <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
                <code>{JSON.stringify(testResult.body, null, 2)}</code>
              </pre>
            </div>
          )}
        </Section>
      </div>

      {/* Webhooks section — hidden for now */}
    </div>
  )
}
