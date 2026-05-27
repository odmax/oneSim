'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { saveAdaptiveProvider, type AdaptiveProviderInput } from '@/lib/actions/adaptive-provider'

type ConnectorStyle = 'URL_TOKEN' | 'HEADER_TOKEN' | 'REST_CATALOG' | 'MOCK'

const CONNECTOR_STYLES: { value: ConnectorStyle; label: string; description: string }[] = [
  { value: 'URL_TOKEN', label: 'URL Token Provider', description: 'Token in URL path, SOAP auth, template bundles' },
  { value: 'HEADER_TOKEN', label: 'Header Token Provider', description: 'Token in Authorization header, subscriber flow' },
  { value: 'REST_CATALOG', label: 'REST Catalog Provider', description: 'Standard REST API with plans catalog' },
  { value: 'MOCK', label: 'Mock Provider', description: 'Simulated provider for development' },
]

const AUTH_FIELDS: Record<ConnectorStyle, { name: string; label: string; type: string; required?: boolean; placeholder?: string }[]> = {
  URL_TOKEN: [
    { name: 'authType', label: 'Auth Type', type: 'select', required: true, placeholder: 'credentials' },
    { name: 'authUrl', label: 'Auth URL', type: 'url', placeholder: 'https://auth.provider.com/soap' },
    { name: 'tokenPlacement', label: 'Token Placement', type: 'select', required: true, placeholder: 'URL_PATH' },
  ],
  HEADER_TOKEN: [
    { name: 'authType', label: 'Auth Type', type: 'select', required: true, placeholder: 'bearer_token' },
    { name: 'apiToken', label: 'API Token', type: 'password', placeholder: 'Provider API token' },
    { name: 'tokenPlacement', label: 'Token Placement', type: 'select', required: true, placeholder: 'HEADER' },
  ],
  REST_CATALOG: [
    { name: 'authType', label: 'Auth Type', type: 'select', required: true, placeholder: 'bearer_token' },
    { name: 'apiToken', label: 'API Token', type: 'password', placeholder: 'Provider API token' },
    { name: 'tokenPlacement', label: 'Token Placement', type: 'select', required: true, placeholder: 'HEADER' },
  ],
  MOCK: [],
}

const AUTH_TYPE_OPTIONS = [
  { value: 'bearer_token', label: 'Bearer Token' },
  { value: 'api_key', label: 'API Key' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'credentials', label: 'Username / Password (SOAP)' },
]

const TOKEN_PLACEMENT_OPTIONS = [
  { value: 'HEADER', label: 'Authorization Header' },
  { value: 'URL_PATH', label: 'URL Path' },
  { value: 'QUERY_PARAM', label: 'Query Parameter' },
]

function Section({ title, description, children, defaultOpen = true }: { title: string; description?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
        </div>
        <span className="text-gray-400 text-lg">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-4 space-y-3">{children}</div>}
    </div>
  )
}

function Field({ name, label, type, value, onChange, placeholder, required, options }: {
  name: string; label: string; type: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; options?: { value: string; label: string }[]
}) {
  if (type === 'select' && options) {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">{label}{required && <span className="text-red-400 ml-0.5">*</span>}</label>
        <select value={value} onChange={e => onChange(e.target.value)} className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
          <option value="">— Select —</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    )
  }
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}{required && <span className="text-red-400 ml-0.5">*</span>}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
    </div>
  )
}

export function AdaptiveProviderSetup() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const [connectorStyle, setConnectorStyle] = useState<ConnectorStyle>('URL_TOKEN')
  const [form, setForm] = useState({
    name: '', code: '', environment: 'staging', apiBaseUrl: '',
    authUrl: '', apiToken: '', authType: 'bearer_token', tokenPlacement: 'HEADER',
    planListPath: '', responseListKey: '',
    fieldSku: 'sku', fieldName: 'name', fieldData: 'data_gb', fieldValidity: 'validity_days', fieldCost: 'price_usd',
    activationPath: '', activationMethod: 'POST',
    statusPath: '', usagePath: '', suspendPath: '', resumePath: '',
  })

  const update = useCallback((key: string, value: string) => setForm(f => ({ ...f, [key]: value })), [])

  const handleStyleChange = useCallback((style: ConnectorStyle) => {
    setConnectorStyle(style)
    const defaults: Record<string, string> = { environment: 'staging', authType: 'bearer_token', tokenPlacement: 'HEADER' }
    if (style === 'URL_TOKEN') { defaults.authType = 'credentials'; defaults.tokenPlacement = 'URL_PATH' }
    if (style === 'HEADER_TOKEN') { defaults.authType = 'bearer_token'; defaults.tokenPlacement = 'HEADER' }
    if (style === 'MOCK') { defaults.authType = 'bearer_token'; defaults.tokenPlacement = 'HEADER' }
    setForm(f => ({ ...f, ...defaults }))
  }, [])

  const finalUrl = form.apiBaseUrl && form.planListPath
    ? `${form.apiBaseUrl.replace(/\/$/, '')}/${form.planListPath.replace(/^\//, '')}`
    : '—'

  const safeUrl = finalUrl !== '—' && form.apiToken
    ? finalUrl.replace(form.apiToken, form.apiToken.slice(0, 4) + '••••')
    : finalUrl

  async function handleSave() {
    setSaving(true)
    setResult(null)
    try {
      const input: AdaptiveProviderInput = {
        name: form.name,
        code: form.code,
        adapterStrategy: 'STANDARD',
        environment: form.environment,
        apiBaseUrl: form.apiBaseUrl,
        authUrl: form.authUrl || undefined,
        apiToken: form.apiToken || undefined,
        authType: form.authType,
        tokenPlacement: form.tokenPlacement,
        planListPath: form.planListPath || undefined,
        responseListKey: form.responseListKey || undefined,
        fieldMappings: {
          sku: form.fieldSku,
          name: form.fieldName,
          data_gb: form.fieldData,
          validity_days: form.fieldValidity,
          price_usd: form.fieldCost,
        },
        activationPath: form.activationPath || undefined,
        statusPath: form.statusPath || undefined,
        usagePath: form.usagePath || undefined,
        suspendPath: form.suspendPath || undefined,
        resumePath: form.resumePath || undefined,
        endpointMappings: form.activationPath ? {
          activate: { method: form.activationMethod || 'POST' },
        } : undefined,
      }
      const r = await saveAdaptiveProvider(input)
      if (r.success !== false) return
      setResult({ type: 'error', message: r.error || 'Save failed' })
    } catch (e: any) {
      setResult({ type: 'error', message: e.message || 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  const set = (key: string) => ({ value: (form as any)[key], onChange: (v: string) => update(key, v) })

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Adaptive Provider Setup</h1>
        <p className="mt-1 text-sm text-gray-500">Configure any eSIM provider without writing code. All paths and field names are configurable.</p>
      </div>

      {result && (
        <div className={`rounded-lg border p-3 text-sm ${result.type === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>
          {result.message}
        </div>
      )}

      <Section title="1. Provider Basics" description="Name, code, environment, and base URL">
        <div className="grid grid-cols-2 gap-3">
          <Field name="name" label="Provider Name" type="text" placeholder="e.g. My eSIM Provider" required {...set('name')} />
          <Field name="code" label="Provider Code" type="text" placeholder="e.g. MYPROV" required {...set('code')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field name="environment" label="Environment" type="select" {...set('environment')} options={[{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }]} />
          <Field name="apiBaseUrl" label="Base URL" type="url" placeholder="https://api.provider.com/v1" required {...set('apiBaseUrl')} />
        </div>
        <Field name="connectorStyle" label="Connector Style" type="select" value={connectorStyle}
          onChange={v => handleStyleChange(v as ConnectorStyle)}
          options={CONNECTOR_STYLES.map(s => ({ value: s.value, label: `${s.label} — ${s.description}` }))} />
      </Section>

      <Section title="2. Authentication" description="How the provider authenticates requests" defaultOpen={!!AUTH_FIELDS[connectorStyle].length}>
        {connectorStyle === 'MOCK' ? (
          <p className="text-sm text-gray-500">Mock providers do not require authentication.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {AUTH_FIELDS[connectorStyle].map(f => {
                if (f.type === 'select') {
                  const options = f.name === 'authType' ? AUTH_TYPE_OPTIONS : f.name === 'tokenPlacement' ? TOKEN_PLACEMENT_OPTIONS : undefined
                  return <Field key={f.name} name={f.name} label={f.label} type="select" options={options} {...set(f.name)} />
                }
                return <Field key={f.name} name={f.name} label={f.label} type={f.type} placeholder={f.placeholder} {...set(f.name)} />
              })}
            </div>
            {form.authType === 'credentials' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                Username/password authentication will be completed in the provider setup wizard after saving.
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="3. Plan Sync" description="Paths and field mappings for syncing plans from the provider">
        <div className="grid grid-cols-2 gap-3">
          <Field name="planListPath" label="Plan List Path" type="text" placeholder="/plans or /api/v1/plans" {...set('planListPath')} />
          <Field name="responseListKey" label="Response List Key" type="text" placeholder="data, results, plans" {...set('responseListKey')} />
        </div>
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">Field Mappings — map provider response fields to OneSim fields</p>
          <div className="grid grid-cols-2 gap-3">
            <Field name="fieldSku" label="SKU field" type="text" placeholder="sku" {...set('fieldSku')} />
            <Field name="fieldName" label="Name field" type="text" placeholder="name" {...set('fieldName')} />
            <Field name="fieldData" label="Data (GB) field" type="text" placeholder="data_gb" {...set('fieldData')} />
            <Field name="fieldValidity" label="Validity (days) field" type="text" placeholder="validity_days" {...set('fieldValidity')} />
            <Field name="fieldCost" label="Cost (USD) field" type="text" placeholder="price_usd" {...set('fieldCost')} />
          </div>
        </div>
        {finalUrl !== '—' && (
          <div className="rounded-lg bg-gray-50 p-3 font-mono text-xs space-y-0.5">
            <p className="text-gray-500">Endpoint URL: <span className="text-gray-800 break-all">{safeUrl}</span></p>
          </div>
        )}
      </Section>

      <Section title="4. Activation" description="Path and method for activating eSIMs" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-3">
          <Field name="activationPath" label="Activation Path" type="text" placeholder="/activate or /api/v1/activate" {...set('activationPath')} />
          <Field name="activationMethod" label="HTTP Method" type="select" {...set('activationMethod')}
            options={[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'PATCH', label: 'PATCH' }]} />
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <p className="font-medium text-gray-700 mb-1">Required Variables — sent in request body</p>
          <code className="text-xs text-gray-800">&#123; "sku": "{form.fieldSku || 'sku'}", "email": "customer@email.com", "quantity": 1 &#125;</code>
        </div>
      </Section>

      <Section title="5. Status & Usage" description="Paths for checking eSIM status and usage" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-3">
          <Field name="statusPath" label="Status Path" type="text" placeholder="/status/{subscriptionId}" {...set('statusPath')} />
          <Field name="usagePath" label="Usage Path" type="text" placeholder="/usage/{iccid}" {...set('usagePath')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field name="suspendPath" label="Suspend Path" type="text" placeholder="/suspend/{subscriptionId}" {...set('suspendPath')} />
          <Field name="resumePath" label="Resume Path" type="text" placeholder="/resume/{subscriptionId}" {...set('resumePath')} />
        </div>
      </Section>

      <Section title="6. Test Panel" description="Test your provider configuration before saving" defaultOpen={true}>
        <p className="text-sm text-gray-500">Save the provider first, then use the Test Connection button on the provider detail page.</p>
      </Section>

      <Section title="7. Save Provider" description="Create the provider with all settings" defaultOpen={true}>
        <div className="flex items-center justify-between">
          <div>
            {form.name && <p className="text-sm text-gray-700">Provider <span className="font-semibold">{form.name}</span> ({form.code.toUpperCase()}) will be created as <span className="font-mono text-xs text-gray-500">STANDARD</span> connector.</p>}
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => router.back()} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving || !form.name || !form.code || !form.apiBaseUrl}
              className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Provider'}
            </button>
          </div>
        </div>
      </Section>
    </div>
  )
}
