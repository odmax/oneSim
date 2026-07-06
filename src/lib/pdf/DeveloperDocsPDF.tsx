import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: 'Helvetica',
    fontSize: 10,
    lineHeight: 1.5,
    color: '#1f2937',
  },
  h1: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 4,
    color: '#111827',
  },
  h2: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 8,
    marginTop: 16,
    color: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingBottom: 4,
  },
  h3: {
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 6,
    marginTop: 12,
    color: '#111827',
  },
  h4: {
    fontSize: 10,
    fontWeight: 700,
    marginBottom: 4,
    marginTop: 8,
    color: '#374151',
  },
  p: {
    marginBottom: 6,
    fontSize: 10,
    color: '#4b5563',
  },
  bold: {
    fontWeight: 700,
  },
  mono: {
    fontFamily: 'Courier',
    fontSize: 8,
  },
  codeBlock: {
    backgroundColor: '#1f2937',
    padding: 10,
    borderRadius: 4,
    marginBottom: 8,
    marginTop: 4,
  },
  codeText: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: '#f3f4f6',
    lineHeight: 1.4,
  },
  inlineCode: {
    fontFamily: 'Courier',
    fontSize: 8,
    backgroundColor: '#f3f4f6',
    color: '#1f2937',
    paddingHorizontal: 2,
  },
  infoBox: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  warningBox: {
    backgroundColor: '#fefce8',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  stepBox: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 700,
    textAlign: 'center',
    lineHeight: 24,
    marginRight: 8,
    flexShrink: 0,
  },
  stepContent: {
    flex: 1,
  },
  card: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    padding: 12,
    marginBottom: 10,
  },
  endpointHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  methodBadgeGet: {
    backgroundColor: '#dcfce7',
    color: '#166534',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 8,
    fontWeight: 700,
  },
  methodBadgePost: {
    backgroundColor: '#dbeafe',
    color: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 8,
    fontWeight: 700,
  },
  endpointPath: {
    fontFamily: 'Courier',
    fontSize: 9,
    color: '#374151',
  },
  table: {
    marginBottom: 8,
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 2,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tableHeader: {
    backgroundColor: '#f9fafb',
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontWeight: 700,
    fontSize: 8,
    color: '#6b7280',
    textTransform: 'uppercase',
  },
  tableCell: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontSize: 8,
    color: '#4b5563',
  },
  tableCellMono: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontFamily: 'Courier',
    fontSize: 7,
    color: '#4b5563',
  },
  statusBadgeYellow: {
    backgroundColor: '#fef9c3',
    color: '#854d0e',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    fontSize: 7,
    fontWeight: 700,
  },
  statusBadgeGreen: {
    backgroundColor: '#dcfce7',
    color: '#166534',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    fontSize: 7,
    fontWeight: 700,
  },
  statusBadgeRed: {
    backgroundColor: '#fef2f2',
    color: '#991b1b',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    fontSize: 7,
    fontWeight: 700,
  },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    textAlign: 'center',
    fontSize: 7,
    color: '#9ca3af',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 8,
  },
  headerSub: {
    fontSize: 10,
    color: '#6b7280',
    marginBottom: 20,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginVertical: 8,
  },
  grid3: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  gridBox: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 8,
    borderRadius: 4,
  },
  gridLabel: {
    fontSize: 8,
    fontWeight: 700,
    color: '#6b7280',
    marginBottom: 2,
  },
  gridValue: {
    fontFamily: 'Courier',
    fontSize: 8,
    color: '#2563eb',
  },
  section: {
    marginBottom: 12,
  },
})

function Col({ width, style, children }: { width?: string; style?: any; children: React.ReactNode }) {
  return <View style={[{ width: width || '25%' }, style]}>{children}</View>
}

function CodeBlock({ code }: { code: string }) {
  return (
    <View style={styles.codeBlock} wrap={false}>
      <Text style={styles.codeText}>{code}</Text>
    </View>
  )
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <Text style={styles.inlineCode}>{children}</Text>
}

function ParamTable({ params }: { params: Array<{ name: string; type: string; required: boolean; description: string }> }) {
  return (
    <View style={styles.table} wrap={false}>
      <View style={[styles.tableRow, { backgroundColor: '#f9fafb' }]}>
        <Text style={[styles.tableHeader, { width: '22%' }]}>Field</Text>
        <Text style={[styles.tableHeader, { width: '13%' }]}>Type</Text>
        <Text style={[styles.tableHeader, { width: '13%' }]}>Required</Text>
        <Text style={[styles.tableHeader, { width: '52%' }]}>Description</Text>
      </View>
      {params.map((p, i) => (
        <View key={p.name} style={[styles.tableRow, i === params.length - 1 ? { borderBottomWidth: 0 } : {}]}>
          <Text style={[styles.tableCellMono, { width: '22%' }]}>{p.name}</Text>
          <Text style={[styles.tableCell, { width: '13%' }]}>{p.type}</Text>
          <Text style={[styles.tableCell, { width: '13%', color: p.required ? '#16a34a' : '#6b7280' }]}>{p.required ? 'Yes' : 'No'}</Text>
          <Text style={[styles.tableCell, { width: '52%' }]}>{p.description}</Text>
        </View>
      ))}
    </View>
  )
}

function StepCard({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.stepBox} wrap={false}>
      <Text style={styles.stepNumber}>{num}</Text>
      <View style={styles.stepContent}>
        <Text style={[styles.h4, { marginTop: 0, marginBottom: 2 }]}>{title}</Text>
        {children}
      </View>
    </View>
  )
}

function EndpointCard({ method, path, description, children }: { method: string; path: string; description: string; children: React.ReactNode }) {
  const isGet = method === 'GET'
  return (
    <View style={styles.card}>
      <View style={styles.endpointHeader}>
        <Text style={isGet ? styles.methodBadgeGet : styles.methodBadgePost}>{method}</Text>
        <Text style={styles.endpointPath}>{path}</Text>
      </View>
      <Text style={styles.p}>{description}</Text>
      {children}
    </View>
  )
}

function EventTable({ rows }: { rows: string[][] }) {
  return (
    <View style={styles.table} wrap={false}>
      <View style={[styles.tableRow, { backgroundColor: '#f9fafb' }]}>
        <Text style={[styles.tableHeader, { width: '40%' }]}>Event</Text>
        <Text style={[styles.tableHeader, { width: '60%' }]}>Description</Text>
      </View>
      {rows.map(([event, desc], i) => (
          <View key={event} style={[styles.tableRow, i === rows.length - 1 ? { borderBottomWidth: 0 } : {}]}>
            <Text style={[styles.tableCellMono, { width: '40%' }]}>{event}</Text>
            <Text style={[styles.tableCell, { width: '60%' }]}>{desc}</Text>
          </View>
        ))}
    </View>
  )
}

function WebhookHeadersTable() {
  const rows: Array<{ name: string; desc: string }> = [
    { name: 'X-OneSim-Event', desc: 'The event type (e.g. order.created)' },
    { name: 'X-OneSim-Signature', desc: 'HMAC SHA256 of the exact JSON body using your endpoint secret' },
    { name: 'X-OneSim-Timestamp', desc: 'Unix timestamp of when the event was generated (tolerance: 5 min)' },
    { name: 'X-OneSim-Delivery-Id', desc: 'Unique ID for this delivery attempt (use for deduplication)' },
  ]
  return (
    <View style={styles.table} wrap={false}>
      <View style={[styles.tableRow, { backgroundColor: '#f9fafb' }]}>
        <Text style={[styles.tableHeader, { width: '35%' }]}>Header</Text>
        <Text style={[styles.tableHeader, { width: '65%' }]}>Description</Text>
      </View>
      {rows.map((r, i) => (
          <View key={r.name} style={[styles.tableRow, i === rows.length - 1 ? { borderBottomWidth: 0 } : {}]}>
            <Text style={[styles.tableCellMono, { width: '35%' }]}>{r.name}</Text>
            <Text style={[styles.tableCell, { width: '65%' }]}>{r.desc}</Text>
          </View>
        ))}
    </View>
  )
}

export default function DeveloperDocsPDF({
  packages,
  baseUrl,
}: {
  packages: Array<{ id: string; name: string; dataGB: number; validityDays: number; priceUSD: string; description: string | null }>
  baseUrl: string
}) {
  const samplePackageId = packages[0]?.id || 'pkg_xxx'
  const apiBase = `${baseUrl}/api/v1`

  const orderParams = [
    { name: 'customerName', type: 'string', required: true, description: 'End customer full name' },
    { name: 'customerEmail', type: 'string', required: true, description: 'End customer email address' },
    { name: 'customerPhone', type: 'string', required: false, description: 'End customer phone number' },
    { name: 'country', type: 'string', required: false, description: 'Customer country' },
    { name: 'packageId', type: 'string', required: false, description: 'Internal package ID (one identifier required)' },
    { name: 'sku', type: 'string', required: false, description: 'Human-readable SKU (e.g. ONESIM-AFRICA-5GB-30D)' },
    { name: 'packageCode', type: 'string', required: false, description: 'Auto-generated package code (e.g. PKG-5GB-30D-X1A)' },
    { name: 'providerPlanId', type: 'string', required: false, description: 'Provider original plan ID' },
    { name: 'quantity', type: 'integer', required: false, description: 'Number of eSIMs (1-100, default 1)' },
    { name: 'externalCustomerId', type: 'string', required: false, description: 'Your internal customer reference' },
  ]

  const packageLine = packages[0]
    ? `${packages[0].name} - ${packages[0].dataGB}GB/${packages[0].validityDays}D - $${packages[0].priceUSD}`
    : '1GB - 7 Days'

  const successResponse = `{
  "success": true,
  "orderId": "cmow...abc123",
  "customerId": "cmow...def456",
  "status": "PENDING_ACTIVATION",
  "esims": [
    {
      "id": "cmow...ghi789",
      "iccid": "89012345678901234567",
      "status": "PENDING_ACTIVATION",
      "qrCodeUrl": "https://api.onesim.africa/qr/89012345678901234567"
    }
  ]
}`

  const packagesResponse = `{
  "success": true,
  "packages": [
    {
      "id": "pkg_xxx",
      "displayName": "OneSIM 1GB 7 Days",
      "dataGB": 1,
      "validityDays": 7,
      "priceUSD": 5.00,
      "unitCost": 5.00,
      "unitPrice": 5.00,
      "currency": "USD",
      "customerDescription": "Perfect for short trips",
      "sku": "ONESIM-1GB-7D",
      "packageCode": "PKG-1GB-7D-X1A"
    },
    {
      "id": "pkg_yyy",
      "displayName": "OneSIM 5GB 30 Days",
      "dataGB": 5,
      "validityDays": 30,
      "priceUSD": 15.00,
      "unitCost": 15.00,
      "unitPrice": 15.00,
      "currency": "USD",
      "customerDescription": "Ideal for monthly use",
      "sku": "ONESIM-5GB-30D",
      "packageCode": "PKG-5GB-30D-Y2B"
    }
  ]
}`

  return (
    <Document
      title="OneSIM Developer API Documentation"
      author="OneTelecom"
      subject="OneSIM Africa Developer API"
    >
      {/* Cover Page */}
      <Page size="A4" style={styles.page}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 60 }}>
          <Text style={{ fontSize: 28, fontWeight: 700, color: '#111827', marginBottom: 8 }}>OneSIM Africa</Text>
          <Text style={{ fontSize: 20, fontWeight: 700, color: '#0891b2', marginBottom: 16 }}>Developer API Documentation</Text>
          <View style={{ width: 60, height: 2, backgroundColor: '#0891b2', marginBottom: 16 }} />
          <Text style={{ fontSize: 10, color: '#6b7280', textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>
            Integrate eSIM ordering into your platform with simple HTTP requests.
            This guide covers everything from your first API call to webhook integration.
          </Text>
          <View style={{ marginTop: 30, backgroundColor: '#f9fafb', padding: 16, borderRadius: 4, width: '80%' }}>
            <Text style={{ fontSize: 9, color: '#6b7280', textAlign: 'center', marginBottom: 4 }}>API Base URL</Text>
            <Text style={{ fontSize: 11, fontFamily: 'Courier', color: '#2563eb', textAlign: 'center' }}>{apiBase}</Text>
          </View>
          <Text style={{ fontSize: 8, color: '#9ca3af', marginTop: 40 }}>Generated on {new Date().toISOString().split('T')[0]}</Text>
        </View>
        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Table of Contents */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Table of Contents</Text>
        <View style={{ marginTop: 16 }}>
          {[
            '1. Overview',
            '2. Quick Start: Send Your First API Request',
            '3. Understanding the Fields',
            '4. Authentication',
            '5. API Endpoints',
            '6. Order Status Values',
            '7. Troubleshooting',
            '8. Code Examples',
            '9. Rate Limiting',
            '10. Webhooks & Callbacks',
          ].map((item, i) => (
            <Text key={i} style={{ fontSize: 10, color: '#374151', paddingVertical: 4, paddingLeft: 8 }}>
              {item}
            </Text>
          ))}
        </View>
        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Overview */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>1. Overview</Text>
        <Text style={styles.p}>
          The OneSIM API lets you order and manage eSIMs from your own systems. You send a simple HTTP request — we handle the rest.
        </Text>

        <View style={styles.grid3}>
          <View style={styles.gridBox}>
            <Text style={styles.gridLabel}>Base URL</Text>
            <Text style={styles.gridValue}>{apiBase}</Text>
          </View>
          <View style={styles.gridBox}>
            <Text style={styles.gridLabel}>Auth Method</Text>
            <Text style={styles.gridValue}>Bearer Token (API Key)</Text>
          </View>
          <View style={styles.gridBox}>
            <Text style={styles.gridLabel}>Content Type</Text>
            <Text style={styles.gridValue}>application/json</Text>
          </View>
        </View>

        <Text style={{ fontSize: 8, color: '#9ca3af' }}>All dates and times are in UTC. Monetary values are in USD.</Text>

        <Text style={{ ...styles.h1, marginTop: 30 }}>2. Quick Start: Send Your First API Request</Text>
        <Text style={styles.p}>
          Follow these steps to place your first eSIM order. No coding experience needed — these steps work with cURL (command line) or any API tool.
        </Text>

        <StepCard num={1} title="Create an API Key">
          <Text style={styles.p}>
            Go to the API Keys page and click "Create API Key". Give it a name like "My App" so you remember what it's for.
          </Text>
          <Text style={{ fontSize: 8, color: '#6b7280' }}>
            Your key will start with onesim_.
          </Text>
        </StepCard>

        <StepCard num={2} title="Copy Your API Key Safely">
          <Text style={styles.p}>
            When you create a key, it is shown only once. Copy it and store it somewhere safe — like a password manager. You will use it in the next steps.
          </Text>
          <Text style={{ fontSize: 8, color: '#991b1b' }}>
            Warning: If you lose it, you cannot see it again. Delete and create a new one.
          </Text>
        </StepCard>

        <StepCard num={3} title="Choose an Active eSIM Package">
          <Text style={styles.p}>
            Each eSIM plan has a packageId — a unique ID that tells us which plan to order. You can list all available packages by calling:
          </Text>
          <CodeBlock code={`curl -X GET "${apiBase}/packages" -H "Authorization: Bearer YOUR_API_KEY"`} />
          <Text style={{ fontSize: 8, color: '#6b7280' }}>
            Pick a packageId from the response. In this guide we will use {samplePackageId}.
          </Text>
        </StepCard>

        <StepCard num={4} title="Prepare Customer Details">
          <Text style={styles.p}>
            You need at least a name and email for the person who will receive the eSIM. A phone number is optional but helpful.
          </Text>
          <Text style={{ fontSize: 8, color: '#6b7280' }}>
            Example: Name = "Jane Smith", Email = "jane@example.com", Country = "South Africa"
          </Text>
        </StepCard>

        <StepCard num={5} title="Send the API Request">
          <Text style={styles.p}>
            Send a POST request to /api/v1/esims/order with the customer details and package ID.
          </Text>
          <Text style={[styles.p, styles.bold]}>cURL (command line):</Text>
          <CodeBlock code={`# Using packageId (traditional)
curl -X POST "${apiBase}/esims/order" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-id-123" \\
  -d '{
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "+27123456789",
    "country": "South Africa",
    "packageId": "${samplePackageId}",
    "quantity": 1
  }'`} />
          <CodeBlock code={`# Using SKU (simpler, human-readable)
curl -X POST "${apiBase}/esims/order" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-id-456" \\
  -d '{
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "+27123456789",
    "country": "South Africa",
    "sku": "ONESIM-AFRICA-5GB-30D",
    "quantity": 1
  }'`} />
        </StepCard>

        <StepCard num={6} title="Read the Response">
          <Text style={styles.p}>
            A successful response includes an orderId, customerId, and a list of esims with their unique ICCID (the eSIM serial number).
          </Text>
          <CodeBlock code={successResponse} />
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 8, color: '#4b5563', fontFamily: 'Courier' }}>
              orderId — Your order reference. Use it to check status later.{'\n'}
              customerId — The unique ID for this customer in our system.{'\n'}
              esims[].id — The eSIM record ID.{'\n'}
              esims[].iccid — The eSIM serial number. Used to download the profile.{'\n'}
              esims[].status — Shows PENDING_ACTIVATION. Becomes ACTIVE once ready.{'\n'}
              esims[].qrCodeUrl — A URL to the QR code for installing the eSIM profile.
            </Text>
          </View>
        </StepCard>

        <StepCard num={7} title="Track Order / eSIM Status">
          <Text style={styles.p}>Check whether your order or eSIM has been activated:</Text>
          <Text style={[styles.p, { fontSize: 9, fontWeight: 700 }]}>Get order status:</Text>
          <CodeBlock code={`curl -X GET "${apiBase}/orders/{orderId}" \\
  -H "Authorization: Bearer YOUR_API_KEY"`} />
          <Text style={[styles.p, { fontSize: 9, fontWeight: 700 }]}>Get eSIM status:</Text>
          <CodeBlock code={`curl -X GET "${apiBase}/esims/{esimId}/status" \\
  -H "Authorization: Bearer YOUR_API_KEY"`} />
        </StepCard>

        <StepCard num={8} title="Use Webhooks for Automatic Updates">
          <Text style={styles.p}>
            Instead of polling (checking repeatedly), set up a webhook — we will call your server when things happen. Go to the Webhooks page to create an endpoint.
          </Text>
          <Text style={{ fontSize: 8, color: '#6b7280' }}>
            We will send events like order.created, esim.activation.completed, or esim.activation.failed to your URL automatically.
          </Text>
        </StepCard>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Understanding the Fields */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>3. Understanding the Fields</Text>
        <Text style={styles.p}>Here is what each field means in plain English:</Text>

        <View style={styles.card}>
          <Text style={styles.h3}>Authorization Header</Text>
          <Text style={styles.p}>
            This is how you prove who you are. Every request must include your API key in an Authorization header. Format:<Text style={styles.inlineCode}> Authorization: Bearer YOUR_API_KEY</Text>. Replace YOUR_API_KEY with the key you created.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h3}>Idempotency-Key Header</Text>
          <Text style={styles.p}>
            A unique ID for each request to prevent duplicate orders. If your network fails and you retry, using the same key ensures the order is only processed once. Use anything unique: a UUID, your database record ID, or order-{'{yourOrderNumber}'}. The key is valid for 24 hours.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h3}>Package Identifiers</Text>
          <Text style={styles.p}>
            You can identify a package using any of the following fields. Only one is required. They are resolved in this priority:{' '}
            <Text style={styles.inlineCode}>packageId</Text> → <Text style={styles.inlineCode}>sku</Text> → <Text style={styles.inlineCode}>packageCode</Text> → <Text style={styles.inlineCode}>providerPlanId</Text>.
          </Text>
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 8, color: '#4b5563', fontFamily: 'Courier' }}>
              packageId — Internal OneSIM package ID (e.g. {samplePackageId}). Get from GET /v1/packages.{'\n'}
              sku — Human-readable stock keeping unit (e.g. ONESIM-AFRICA-5GB-30D).{'\n'}
              packageCode — Short auto-generated code (e.g. PKG-5GB-30D-X1A2B3C).{'\n'}
              providerPlanId — The provider original plan ID (e.g. ext-provider-plan-5gb).
            </Text>
          </View>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.h3}>Pricing Fields</Text>
          <Text style={styles.p}>
            Every package and order response includes the OneSIM client price. You may add your own markup when reselling to your customers.
          </Text>
          <Text style={{ fontSize: 8, color: '#4b5563', fontFamily: 'Courier', marginTop: 4 }}>
            unitCost / unitPrice — The OneSIM price per eSIM (maps from priceUSD). This is your cost.{'\n'}
            totalCost — unitCost × quantity. The total charged to your wallet.{'\n'}
            quantity — Number of eSIMs purchased in this order.{'\n'}
            currency — Always USD.{'\n'}
            Note: unitCost is the OneSIM client price. You may set a higher suggestedRetailPrice on your platform.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h3}>Customer Fields</Text>
          <Text style={styles.p}>
            These are the details of the end user — the person who will receive and use the eSIM. customerName and customerEmail are required. customerPhone is useful if you want to send setup instructions via SMS. country helps us select the right network configuration.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h3}>callbackUrl (Optional)</Text>
          <Text style={styles.p}>
            A URL we will call when the eSIM status changes. If you do not want to set up a full webhook endpoint, you can include this per-order and we will send a POST request to your URL with the updated status.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h3}>Status Values</Text>
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 8, color: '#4b5563', marginBottom: 2 }}>
              <Text style={styles.statusBadgeYellow}> PENDING_ACTIVATION </Text> — Order received. Waiting for the provider to activate the eSIM.
            </Text>
            <Text style={{ fontSize: 8, color: '#4b5563', marginBottom: 2 }}>
              <Text style={styles.statusBadgeGreen}> ACTIVE </Text> — eSIM is ready to use. Download the profile using the QR code or install code.
            </Text>
            <Text style={{ fontSize: 8, color: '#4b5563' }}>
              <Text style={styles.statusBadgeRed}> FAILED </Text> — Something went wrong. No charge was made. Contact support or try again.
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Authentication */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>4. Authentication</Text>
        <Text style={styles.p}>
          Every API request must include your API key in the Authorization header. You manage keys in the API Keys page.
        </Text>
        <CodeBlock code={`Authorization: Bearer YOUR_API_KEY`} />
        <Text style={{ fontSize: 8, color: '#6b7280', marginTop: 4 }}>
          Replace YOUR_API_KEY with your actual key. Keys start with onesim_ and are shown only once when created.
        </Text>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* API Endpoints */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>5. API Endpoints</Text>

        <EndpointCard method="GET" path="/api/v1/packages" description="List all active eSIM packages with pricing and details.">
          <Text style={[styles.p, styles.bold]}>Response</Text>
          <CodeBlock code={packagesResponse} />
        </EndpointCard>

        <EndpointCard method="POST" path="/api/v1/esims/order" description="Create a new eSIM order. The request is routed to the appropriate provider based on the package configuration.">
          <Text style={[styles.p, styles.bold]}>Request Body</Text>
          <ParamTable params={orderParams} />
          <Text style={[styles.p, styles.bold, { marginTop: 8 }]}>Success Response (200)</Text>
          <CodeBlock code={successResponse} />
          <Text style={[styles.p, styles.bold, { marginTop: 8 }]}>Error Responses</Text>

          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>400 — Validation Error</Text>
            <CodeBlock code={`{ "success": false, "error": "customerName and customerEmail are required" }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>401 — Authentication Error</Text>
            <CodeBlock code={`{ "success": false, "error": "Missing or invalid Authorization header" }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>402 — Insufficient Balance</Text>
            <CodeBlock code={`{ "success": false, "error": "Insufficient wallet balance" }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>403 — Suspended Business</Text>
            <CodeBlock code={`{ "success": false, "error": "Business account is suspended" }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>404 — Package Not Found</Text>
            <CodeBlock code={`{ "success": false, "error": "Package not found or inactive" }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>429 — Rate Limit Exceeded</Text>
            <CodeBlock code={`{ "success": false, "error": "Rate limit exceeded. Please reduce request volume and retry after 60 seconds." }`} />
          </View>
          <View style={styles.errorBox}>
            <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>502 — Provider Error</Text>
            <CodeBlock code={`{ "success": false, "error": "Provider activation failed" }`} />
          </View>

          <Text style={[styles.p, styles.bold, { marginTop: 8 }]}>Idempotency-Key</Text>
          <Text style={styles.p}>
            Include an Idempotency-Key header to prevent duplicate orders. If the same key is reused within 24 hours, the original response is returned without processing a new order.
          </Text>
          <CodeBlock code={`Idempotency-Key: unique-request-id-123`} />
        </EndpointCard>

        <EndpointCard method="GET" path="/api/v1/orders/{orderId}" description="Get the status of a specific order including all eSIMs in that order.">
          <Text style={[styles.p, styles.bold]}>Path Parameters</Text>
          <ParamTable params={[
            { name: 'orderId', type: 'string', required: true, description: 'Order ID returned from POST /api/v1/esims/order' },
          ]} />
          <Text style={[styles.p, styles.bold, { marginTop: 4 }]}>Response</Text>
          <CodeBlock code={`{
  "success": true,
  "orderId": "cmow...abc123",
  "status": "PENDING_ACTIVATION",
  "unitCost": 5.00,
  "totalCost": 5.00,
  "quantity": 1,
  "currency": "USD",
  "esims": [
    { "iccid": "89012345678901234567", "status": "PENDING_ACTIVATION" }
  ]
}`} />
        </EndpointCard>

        <EndpointCard method="GET" path="/api/v1/esims/{esimId}/status" description="Get the current status and details for a specific eSIM.">
          <Text style={[styles.p, styles.bold]}>Path Parameters</Text>
          <ParamTable params={[
            { name: 'esimId', type: 'string', required: true, description: 'eSIM ID returned from order creation' },
          ]} />
          <Text style={[styles.p, styles.bold, { marginTop: 4 }]}>Response</Text>
          <CodeBlock code={`{
  "success": true,
  "id": "cmow...ghi789",
  "iccid": "89012345678901234567",
  "status": "ACTIVE",
  "qrCodeUrl": "https://api.onesim.africa/qr/89012345678901234567",
  "activatedAt": "2026-05-09T12:05:00Z",
  "expiresAt": "2026-05-16T12:00:00Z"
}`} />
        </EndpointCard>

        <EndpointCard method="GET" path="/api/v1/customers" description="List all customers registered under your business.">
          <Text style={[styles.p, styles.bold]}>Query Parameters</Text>
          <ParamTable params={[
            { name: 'search', type: 'string', required: false, description: 'Search by name or email' },
            { name: 'page', type: 'integer', required: false, description: 'Page number (default 1)' },
            { name: 'limit', type: 'integer', required: false, description: 'Results per page (default 20, max 100)' },
          ]} />
          <Text style={[styles.p, styles.bold, { marginTop: 4 }]}>Response</Text>
          <CodeBlock code={`{
  "success": true,
  "customers": [
    {
      "id": "cmow...cust1",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+27123456789",
      "country": "South Africa",
      "esimCount": 2,
      "createdAt": "2026-05-01T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}`} />
        </EndpointCard>

        <EndpointCard method="GET" path="/api/v1/orders" description="List all orders placed by your business.">
          <Text style={[styles.p, styles.bold]}>Query Parameters</Text>
          <ParamTable params={[
            { name: 'status', type: 'string', required: false, description: 'Filter by status: PENDING_ACTIVATION, ACTIVE, FAILED' },
            { name: 'page', type: 'integer', required: false, description: 'Page number (default 1)' },
            { name: 'limit', type: 'integer', required: false, description: 'Results per page (default 20, max 100)' },
          ]} />
          <Text style={[styles.p, styles.bold, { marginTop: 4 }]}>Response</Text>
          <CodeBlock code={`{
  "success": true,
  "orders": [
    {
      "orderId": "cmow...abc123",
      "status": "PENDING_ACTIVATION",
      "packageName": "1GB - 7 Days",
      "quantity": 1,
      "totalAmount": 5.00,
      "customerEmail": "john@example.com",
      "createdAt": "2026-05-09T12:00:00Z",
      "esims": [
        { "iccid": "89012345678901234567", "status": "PENDING_ACTIVATION" }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}`} />
        </EndpointCard>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Order Status Values */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>6. Order Status Values</Text>
        <View style={styles.table} wrap={false}>
          <View style={[styles.tableRow, { backgroundColor: '#f9fafb' }]}>
            <Text style={[styles.tableHeader, { width: '35%' }]}>Status</Text>
            <Text style={[styles.tableHeader, { width: '65%' }]}>Description</Text>
          </View>
          <View style={[styles.tableRow, { borderBottomWidth: 0 }]}>
            <Text style={[styles.tableCell, { width: '35%' }]}>
              <Text style={styles.statusBadgeYellow}> PENDING_ACTIVATION </Text>
            </Text>
            <Text style={[styles.tableCell, { width: '65%' }]}>Order created, activation in progress</Text>
          </View>
          <View style={[styles.tableRow, { borderBottomWidth: 0 }]}>
            <Text style={[styles.tableCell, { width: '35%' }]}>
              <Text style={styles.statusBadgeGreen}> ACTIVE </Text>
            </Text>
            <Text style={[styles.tableCell, { width: '65%' }]}>eSIM activated and ready to use</Text>
          </View>
          <View style={[styles.tableRow, { borderBottomWidth: 0 }]}>
            <Text style={[styles.tableCell, { width: '35%' }]}>
              <Text style={styles.statusBadgeRed}> FAILED </Text>
            </Text>
            <Text style={[styles.tableCell, { width: '65%' }]}>Activation failed, no wallet charge</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Troubleshooting */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>7. Troubleshooting</Text>
        <Text style={styles.p}>
          If your request does not work the way you expect, here is what to check for each type of error:
        </Text>

        <View style={styles.errorBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>401 — Invalid API Key</Text>
          <Text style={[styles.p, { color: '#991b1b' }]}>What it means: Your API key is missing, expired, or typed incorrectly.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Make sure you included the{" "}Authorization: Bearer YOUR_KEY header.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Check that the key still starts with onesim_ and has no extra spaces.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Go to API Keys and verify the key is active and not deleted.</Text>
        </View>

        <View style={styles.errorBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>403 — Business Not Approved / Suspended</Text>
          <Text style={[styles.p, { color: '#991b1b' }]}>What it means: Your business account is not active or has been suspended.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Check your business status on the Profile page.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Contact support if your account should be active but is not.</Text>
        </View>

        <View style={styles.errorBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>400 — Missing or Invalid Fields</Text>
          <Text style={[styles.p, { color: '#991b1b' }]}>What it means: One or more required fields are missing or have invalid values.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Make sure you included customerName and customerEmail in the request body.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Provide at least one package identifier: packageId, sku, packageCode, or providerPlanId.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Check that the identifier resolves to an active package (call GET /api/v1/packages).</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Ensure quantity is a number between 1 and 100.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Make sure your JSON is valid — no trailing commas, quotes balanced.</Text>
        </View>

        <View style={styles.errorBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>429 — Rate Limit Exceeded</Text>
          <Text style={[styles.p, { color: '#991b1b' }]}>What it means: You sent too many requests in a short time. The rate limit is 60 requests per minute per business.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Wait for the time specified in the Retry-After response header before sending more requests.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• If you need a higher limit, contact support to have it adjusted.</Text>
        </View>

        <View style={styles.errorBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#991b1b' }]}>500 / 502 — Provider / Server Error</Text>
          <Text style={[styles.p, { color: '#991b1b' }]}>What it means: Something went wrong on our side or on the provider side. Your wallet was not charged.</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• Wait a few minutes and retry with the same Idempotency-Key (it will not create a duplicate).</Text>
          <Text style={{ fontSize: 8, color: '#991b1b', marginLeft: 8 }}>• If the error persists, contact support with your orderId or Idempotency-Key.</Text>
        </View>

        <View style={styles.warningBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#854d0e' }]}>General Tips</Text>
          <Text style={{ fontSize: 8, color: '#854d0e', marginLeft: 8 }}>• Use the Test Console to try a request with your admin session before calling via API.</Text>
          <Text style={{ fontSize: 8, color: '#854d0e', marginLeft: 8 }}>• Always include an Idempotency-Key to prevent duplicate charges from retries.</Text>
          <Text style={{ fontSize: 8, color: '#854d0e', marginLeft: 8 }}>• If using Postman, check that you are sending raw JSON body (not form-data).</Text>
          <Text style={{ fontSize: 8, color: '#854d0e', marginLeft: 8 }}>• Check your wallet balance — 402 errors mean insufficient funds.</Text>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Code Examples */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>8. Code Examples</Text>
        <Text style={styles.p}>
          Ready-to-use code snippets. Replace YOUR_API_KEY with your actual API key and copy-paste.
        </Text>

        <Text style={styles.h3}>cURL — Place an Order</Text>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4 }}>
          Works on any machine with curl installed (Mac, Linux, Windows). Use sku or packageId.
        </Text>
        <CodeBlock code={`# Using SKU (recommended for integrations)
curl -X POST ${apiBase}/esims/order \\
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
}'`} />

        <Text style={styles.h3}>cURL — List Packages</Text>
        <CodeBlock code={`curl -X GET ${apiBase}/packages \\
  -H "Authorization: Bearer YOUR_API_KEY"`} />

        <Text style={styles.h3}>JavaScript (fetch) — Place an Order</Text>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4 }}>
          Works in browsers, Node.js 18+, Deno, Bun.
        </Text>
        <CodeBlock code={`// Using SKU for readability
const response = await fetch("${apiBase}/esims/order", {
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
console.log("Response:", data);`} />

        <Text style={styles.h3}>Node.js (axios)</Text>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4 }}>
          If you use axios in your Node.js project.
        </Text>
        <CodeBlock code={`import axios from "axios";
const response = await axios.post(
  "${apiBase}/esims/order",
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
console.log("Response:", response.data);`} />

        <Text style={styles.h3}>Python</Text>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4 }}>
          Plain Python 3 with the built-in urllib library.
        </Text>
        <CodeBlock code={`import json
import urllib.request

url = "${apiBase}/esims/order"
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
    "sku": "ONESIM-AFRICA-5GB-30D",
    "quantity": 1,
}).encode("utf-8")

req = urllib.request.Request(url, data=body, headers=headers, method="POST")
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())
    print("Status:", resp.status)
    print("Response:", data)`} />

        <Text style={styles.h3}>No-Code / Low-Code Tools</Text>
        <Text style={styles.p}>
          You do not need to write code to use the OneSIM API. These tools let you send HTTP requests visually:
        </Text>

        <View style={styles.card}>
          <Text style={[styles.p, { fontWeight: 700 }]}>Postman</Text>
          <Text style={styles.p}>Free desktop app. Create a POST request, set the URL, add headers and body, click Send.</Text>
        </View>
        <View style={styles.card}>
          <Text style={[styles.p, { fontWeight: 700 }]}>Make.com (formerly Integromat)</Text>
          <Text style={styles.p}>Use the "HTTP – Make a request" module. Set method to POST, enter URL, add headers, and paste the JSON body.</Text>
        </View>
        <View style={styles.card}>
          <Text style={[styles.p, { fontWeight: 700 }]}>n8n / Zapier</Text>
          <Text style={styles.p}>Use the "Webhook" or "HTTP Request" node. Configure with POST method, URL, headers, and JSON body.</Text>
        </View>
        <View style={styles.card}>
          <Text style={[styles.p, { fontWeight: 700 }]}>Thunder Client (VS Code)</Text>
          <Text style={styles.p}>VS Code extension. Create a new request, select POST, enter URL, add headers, paste JSON body, click Send.</Text>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Rate Limiting */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>9. Rate Limiting</Text>
        <Text style={styles.p}>
          API requests are rate-limited to protect the platform from excessive traffic. Limits are applied per business on a rolling 60-second window.
        </Text>

        <View style={styles.infoBox}>
          <Text style={[styles.p, { fontWeight: 700 }]}>Default Rate Limit</Text>
          <Text style={styles.p}>60 requests per minute per business. This can be adjusted per business by an admin in the business settings.</Text>
        </View>
        <View style={styles.warningBox}>
          <Text style={[styles.p, { fontWeight: 700, color: '#854d0e' }]}>Rate Limit Headers</Text>
          <Text style={[styles.p, { color: '#854d0e' }]}>
            Every response includes X-RateLimit-Limit and X-RateLimit-Remaining headers so you can track your current usage programmatically.
          </Text>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>

      {/* Webhooks */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>10. Webhooks & Callbacks</Text>
        <Text style={styles.p}>
          OneSIM can notify your platform in real-time when eSIM events occur. Configure webhook endpoints in the Webhooks page or use the callbackUrl field per-order.
        </Text>

        <View style={styles.infoBox}>
          <Text style={[styles.p, { fontWeight: 700 }]}>Webhook Setup Guide</Text>

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
            <Text style={styles.stepNumber}>1</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 8, color: '#4b5563' }}>
                <Text style={{ fontWeight: 700 }}>Create an endpoint</Text> — Go to Webhooks, click "Add Endpoint". Enter your server URL (must use HTTPS) and select which events to receive.
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
            <Text style={styles.stepNumber}>2</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 8, color: '#4b5563' }}>
                <Text style={{ fontWeight: 700 }}>Copy your secret</Text> — After creation, a signing secret is shown once. Save it in your server environment variables. It will not be shown again.
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
            <Text style={styles.stepNumber}>3</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 8, color: '#4b5563' }}>
                <Text style={{ fontWeight: 700 }}>Verify signatures</Text> — Every webhook includes an X-OneSim-Signature header. Use HMAC SHA256 with your secret to verify the payload came from OneSIM.
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
            <Text style={styles.stepNumber}>4</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 8, color: '#4b5563' }}>
                <Text style={{ fontWeight: 700 }}>Handle events</Text> — Listen for order.created, esim.activation.completed, etc. Each event has a clear payload with order status, eSIM ICCID, and QR code URL when activated.
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={styles.stepNumber}>5</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 8, color: '#4b5563' }}>
                <Text style={{ fontWeight: 700 }}>Return 200 OK</Text> — Your endpoint must respond with HTTP 200 within 15 seconds. OneSIM retries failed deliveries 5 times with exponential backoff (30s to 30 min).
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.h3}>Available Events</Text>
        <EventTable rows={[
          ['order.created', 'Order created and submitted to provider'],
          ['esim.activation.pending', 'eSIM activation submitted to provider'],
          ['esim.activation.completed', 'eSIM successfully activated'],
          ['esim.activation.failed', 'eSIM activation rejected by provider'],
          ['esim.usage.updated', 'Usage data synced for an eSIM'],
          ['order.failed', 'Order permanently failed'],
        ]} />

        <Text style={styles.h3}>Signature Verification</Text>
        <Text style={styles.p}>
          Each webhook request includes an HMAC SHA256 signature in the X-OneSim-Signature header. Verify it using your endpoint secret:
        </Text>
        <CodeBlock code={`// Node.js signature verification
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const json = JSON.stringify(payload);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(json)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Usage in Express.js:
app.post('/webhooks/onesim', (req, res) => {
  const signature = req.headers['x-onesim-signature'];
  const secret = process.env.WEBHOOK_SECRET;
  
  if (!verifyWebhook(req.body, signature, secret)) {
    return res.status(401).send('Invalid signature');
  }
  
  // Process webhook...
  res.status(200).send('OK');
});`} />

        <Text style={styles.h3}>Example Payloads</Text>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4 }}>When an order is created:</Text>
        <CodeBlock code={`{
  "event": "order.created",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "orderId": "cmow...abc123",
    "status": "PENDING_ACTIVATION",
    "packageName": "5GB - 30 Days",
    "quantity": 2,
    "totalAmount": "30.00",
    "esims": [
      { "iccid": "89012345678901234567", "status": "PENDING_ACTIVATION" }
    ]
  }
}`} />
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 4, marginTop: 8 }}>When activation is completed:</Text>
        <CodeBlock code={`{
  "event": "esim.activation.completed",
  "timestamp": "2024-01-15T10:32:00.000Z",
  "data": {
    "orderId": "cmow...abc123",
    "status": "ACTIVE",
    "packageName": "5GB - 30 Days",
    "quantity": 2,
    "totalAmount": "30.00",
    "esims": [
      { "iccid": "89012345678901234567", "status": "ACTIVE" }
    ]
  }
}`} />

        <Text style={styles.h3}>Headers</Text>
        <WebhookHeadersTable />

        <View style={styles.infoBox}>
          <Text style={{ fontSize: 8, color: '#1e40af' }}>
            <Text style={{ fontWeight: 700 }}>Respond with 200 OK</Text> within 15 seconds to acknowledge receipt. OneSIM retries failed deliveries 5 times with exponential backoff.
          </Text>
        </View>
        <View style={styles.warningBox}>
          <Text style={{ fontSize: 8, color: '#854d0e' }}>
            <Text style={{ fontWeight: 700 }}>Timestamp tolerance:</Text> The X-OneSim-Timestamp header contains the event time. We recommend rejecting webhooks with timestamps more than 5 minutes from your server clock to prevent replay attacks.
          </Text>
        </View>

        <View style={styles.footer}>
          <Text>OneSIM Africa Developer API Documentation v1.0</Text>
        </View>
      </Page>
    </Document>
  )
}
