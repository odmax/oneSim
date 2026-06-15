'use client'

import Link from 'next/link'
import { createProvider } from '@/lib/actions/providers'
import { useCallback, useState } from 'react'

type SavedTemplate = {
  id: string
  name: string
  description: string | null
  connectorType: string
  authType: string
  tokenPlacement: string
  defaultBaseUrl: string | null
  defaultAuthUrl: string | null
  defaultPlanListPath: string | null
  defaultActivationPath: string | null
  defaultStatusPath: string | null
  defaultUsagePath: string | null
  defaultSuspendPath: string | null
  defaultResumePath: string | null
  defaultResponseListKey: string | null
  defaultFieldMappings: any
  defaultCapabilities: any
  endpointMappings: any
  requiredConfigFields?: any
}

type BuiltInTemplate = {
  label: string
  description: string
  presets: Partial<{
    adapterStrategy: string
    authType: string
    apiBaseUrl: string
    authUrl: string
    apiToken: string
    environment: string
  }>
}

const BUILTIN_TEMPLATES: Record<string, BuiltInTemplate> = {
  custom: {
    label: 'Custom (Start Blank)',
    description: 'Configure every field manually',
    presets: {},
  },
  url_token: {
    label: 'URL Token Provider',
    description: 'Token in URL path, SOAP auth, template bundles',
    presets: {
      adapterStrategy: 'URL_TOKEN',
      authType: 'credentials',
      apiBaseUrl: '',
      authUrl: '',
      environment: 'staging',
    },
  },
  header_token: {
    label: 'Header Token Provider',
    description: 'Token in Authorization header, subscriber flow',
    presets: {
      adapterStrategy: 'HEADER_TOKEN',
      authType: 'bearer_token',
      apiBaseUrl: '',
      environment: 'staging',
    },
  },
  rest_catalog: {
    label: 'REST Catalog Provider',
    description: 'Standard REST API with plans catalog',
    presets: {
      adapterStrategy: 'REST_CATALOG',
      authType: 'bearer_token',
      apiBaseUrl: '',
      environment: 'staging',
    },
  },
  mock: {
    label: 'Mock Provider (Development)',
    description: 'Simulated provider for development and testing',
    presets: {
      adapterStrategy: 'MOCK',
      authType: 'bearer_token',
      environment: 'staging',
    },
  },
}

function setField(name: string, value: string) {
  const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)
  if (el) el.value = value
}

export function NewProviderForm({ templates = [] }: { templates?: SavedTemplate[] }) {
  // Controlled state for hidden/meta fields (avoids React overriding DOM setField)
  const [hiddenEndpointMappings, setHiddenEndpointMappings] = useState('')
  const [hiddenAdapterStrategy, setHiddenAdapterStrategy] = useState('')
  const [hiddenProviderTemplateId, setHiddenProviderTemplateId] = useState('')
  const [hiddenRequestMappings, setHiddenRequestMappings] = useState('')
  const [hiddenResponseMappings, setHiddenResponseMappings] = useState('')
  const [hiddenRequiredConfigFields, setHiddenRequiredConfigFields] = useState('')

  const applyBuiltinTemplate = useCallback((templateId: string) => {
    const template = BUILTIN_TEMPLATES[templateId]
    if (!template) return
    setField('adapterStrategy', template.presets.adapterStrategy || '')
    setHiddenAdapterStrategy(template.presets.adapterStrategy || '')
    setField('authType', template.presets.authType || 'bearer_token')
    setField('apiBaseUrl', template.presets.apiBaseUrl || '')
    setField('authUrl', template.presets.authUrl || '')
    setField('apiToken', template.presets.apiToken || '')
    setField('environment', template.presets.environment || 'staging')
  }, [])

  const applySavedTemplate = useCallback((templateJson: string) => {
    const t: SavedTemplate = JSON.parse(templateJson)

    const connectorToAdapter: Record<string, string> = {
      STANDARD: 'STANDARD', URL_TOKEN: 'URL_TOKEN',
      HEADER_TOKEN: 'HEADER_TOKEN', REST_CATALOG: 'REST_CATALOG', MOCK: 'MOCK',
    }
    setField('adapterStrategy', connectorToAdapter[t.connectorType] || '')
    setField('authType', t.authType || 'bearer_token')
    setField('apiBaseUrl', t.defaultBaseUrl || '')
    setField('authUrl', t.defaultAuthUrl || '')

    // Clear token — never copied from template
    setField('apiToken', '')

    // Set hidden/section fields via setField for each path
    setField('planListPath', t.defaultPlanListPath || '')
    setField('activationPath', t.defaultActivationPath || '')
    setField('statusPath', t.defaultStatusPath || '')
    setField('usagePath', t.defaultUsagePath || '')
    setField('suspendPath', t.defaultSuspendPath || '')
    setField('resumePath', t.defaultResumePath || '')
    setField('responseListKey', t.defaultResponseListKey || '')
    setField('tokenPlacement', t.tokenPlacement || 'URL_PATH')

    // Field mappings get stored as JSON — the edit form handles it
    if (t.defaultFieldMappings && typeof t.defaultFieldMappings === 'object') {
      const fm = t.defaultFieldMappings as Record<string, string>
      if (fm.sku) setField('fieldSku', fm.sku)
      if (fm.name) setField('fieldName', fm.name)
      if (fm.data_gb) setField('fieldData', fm.data_gb)
      if (fm.validity_days) setField('fieldValidity', fm.validity_days)
      if (fm.price_usd) setField('fieldCost', fm.price_usd)
    }

    // Endpoint mappings (capability → endpoint)
    if (t.endpointMappings) {
      const json = JSON.stringify(t.endpointMappings)
      setField('endpointMappings', json)
      setHiddenEndpointMappings(json)
    }

    // Provider template ID
    setHiddenProviderTemplateId(t.id)
    setField('providerTemplateId', t.id)

    // Request/response mappings (cast from JSON to string)
    const tAny = t as any
    setHiddenRequestMappings(JSON.stringify(tAny.requestMappings || ''))
    setHiddenResponseMappings(JSON.stringify(tAny.responseMappings || ''))

    // Store dynamic config fields for credential rendering
    if (t.requiredConfigFields && t.requiredConfigFields.length > 0) {
      setConfigFields(t.requiredConfigFields)
      setHiddenRequiredConfigFields(JSON.stringify(t.requiredConfigFields))
    }

    // Capabilities not needed on create — configured post-creation
  }, [])

  const handleTemplateChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value
    if (val.startsWith('saved:')) {
      applySavedTemplate(val.slice(6))
    } else {
      applyBuiltinTemplate(val)
    }
  }, [applyBuiltinTemplate, applySavedTemplate])

  const hasSavedTemplates = templates.length > 0
  const [configFields, setConfigFields] = useState<SavedTemplate['requiredConfigFields']>([])

  // Auto-apply template when provider code matches a template name
  const handleCodeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const code = e.target.value.toUpperCase()
    const match = templates.find(t => t.name.toUpperCase().includes(code) || code.includes(t.name.toUpperCase()))
    if (match) {
      const templateJson = JSON.stringify(match)
      const selector = document.querySelector<HTMLSelectElement>('[name="template"]')
      if (selector) {
        // Find or create an option with the value "saved:{json}"
        let option = Array.from(selector.options).find(o => o.value === `saved:${templateJson}`)
        if (!option) {
          option = new Option(match.name, `saved:${templateJson}`, true, true)
          selector.add(option)
        }
        selector.value = `saved:${templateJson}`
        applySavedTemplate(templateJson)
      }
    }
  }, [templates, applySavedTemplate])

  return (
    <form action={createProvider} className="space-y-4">
      <input type="hidden" name="type" value="CUSTOM" />
      <input type="hidden" name="endpointMappings" value={hiddenEndpointMappings} />
      <input type="hidden" name="adapterStrategy" value={hiddenAdapterStrategy} />
      <input type="hidden" name="providerTemplateId" value={hiddenProviderTemplateId} />
      <input type="hidden" name="requestMappings" value={hiddenRequestMappings} />
      <input type="hidden" name="responseMappings" value={hiddenResponseMappings} />
      <input type="hidden" name="requiredConfigFields" value={hiddenRequiredConfigFields} />

      <div>
        <label htmlFor="template" className="block text-sm font-medium text-gray-700">Provider Template</label>
        <p className="text-xs text-gray-400 mb-1">Choose a template to pre-fill settings, or start blank.</p>
        <select id="template" name="template" defaultValue="custom" onChange={handleTemplateChange}
          className="mt-1 block w-full max-w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          style={{ maxWidth: '100%', minWidth: 0 }}
        >
          <optgroup label="Built-in Templates">
            {Object.entries(BUILTIN_TEMPLATES).map(([id, t]) => (
              <option key={id} value={id} className="truncate">{t.label}</option>
            ))}
          </optgroup>
          {hasSavedTemplates && (
            <optgroup label="Saved Templates">
              {templates.map(t => (
                <option key={t.id} value={`saved:${JSON.stringify(t)}`} className="truncate">{t.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        <p className="mt-1 text-xs text-gray-400">Template descriptions appear on hover. <Link href="/admin/provider-templates" className="text-cyan-600 underline">Manage Templates</Link></p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Provider Name</label>
          <input id="name" name="name" type="text" required placeholder="e.g. My eSIM Provider" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label htmlFor="code" className="block text-sm font-medium text-gray-700">Provider Code</label>
          <input id="code" name="code" type="text" required placeholder="e.g. AIRHUB" onChange={handleCodeChange} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-mono uppercase focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-gray-500">Unique identifier, auto-uppercased.</p>
        </div>
      </div>

      <div>
        <label htmlFor="adapterStrategy" className="block text-sm font-medium text-gray-700">Connector Type</label>
        <p className="text-xs text-gray-400 mb-1">Select the connector that matches how this provider works.</p>
        <select id="adapterStrategy" name="adapterStrategy" defaultValue="REST_CATALOG"
          className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="MOCK">Mock — Simulated provider for development</option>
          <option value="REST_CATALOG">REST API Provider — Standard REST API with plans catalog</option>
          <option value="URL_TOKEN">URL Token Provider — Token in URL path, SOAP auth, template bundles</option>
          <option value="HEADER_TOKEN">Header Token Provider — Token in Authorization header, subscriber flow</option>
          <option value="STANDARD">Standard — Path-based connector with endpoint mappings</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="environment" className="block text-sm font-medium text-gray-700">Environment</label>
          <select id="environment" name="environment" defaultValue="staging" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
        </div>
        <div>
          <label htmlFor="authType" className="block text-sm font-medium text-gray-700">Auth Type</label>
          <select id="authType" name="authType" defaultValue="bearer_token" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="bearer_token">Bearer Token</option>
            <option value="api_key">API Key</option>
            <option value="basic">Basic Auth</option>
            <option value="credentials">Username / Password</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="apiBaseUrl" className="block text-sm font-medium text-gray-700">API Base URL</label>
          <input id="apiBaseUrl" name="apiBaseUrl" type="url" defaultValue="" placeholder="https://api.provider.com/v1" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label htmlFor="authUrl" className="block text-sm font-medium text-gray-700">Auth URL (optional)</label>
          <input id="authUrl" name="authUrl" type="text" defaultValue="" placeholder="https://auth.provider.com/token or /relative/path" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-gray-400">Separate auth endpoint if different from API Base URL.</p>
        </div>
      </div>

      <div>
        <label htmlFor="apiToken" className="block text-sm font-medium text-gray-700">API Token / Key</label>
        <input id="apiToken" name="apiToken" type="password" placeholder="Provider API token (optional — set up after creation)" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        <p className="mt-1 text-xs text-gray-500">Optional. You can set up authentication after creation.</p>
      </div>

      {configFields && configFields.length > 0 && (
        <div className="rounded-lg border border-cyan-100 bg-cyan-50 p-4">
          <h4 className="text-sm font-semibold text-cyan-800 mb-3">Provider Credentials</h4>
          {configFields?.map((f: any) => (
            <div key={f.name} className="mb-3">
              <label htmlFor={`cfg-${f.name}`} className="block text-sm font-medium text-gray-700 mb-1">
                {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              <input id={`cfg-${f.name}`} name={f.name} type={f.type || 'text'} required={f.required}
                placeholder={f.placeholder || ''} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
          ))}
          <p className="text-xs text-cyan-600">Credentials are stored in the provider config and used for authentication.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="status" className="block text-sm font-medium text-gray-700">Status</label>
          <select id="status" name="status" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="ACTIVE">Active</option>
            <option value="TESTING">Testing</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>
        <div>
          <label htmlFor="priority" className="block text-sm font-medium text-gray-700">Routing Priority</label>
          <input id="priority" name="priority" type="number" defaultValue={0} min={0} className="mt-1 block w-32 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-gray-500">Lower number = higher priority.</p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer hover:bg-gray-50">
          <input type="checkbox" name="isDefaultFallback" className="rounded border-gray-300" />
          <span>Default Fallback Provider</span>
        </label>
      </div>

      <div>
        <label htmlFor="regions" className="block text-sm font-medium text-gray-700">Regions (JSON array)</label>
        <textarea id="regions" name="regions" rows={3} placeholder='["South Africa", "Nigeria", "Kenya"]' className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none" />
        <p className="mt-1 text-xs text-gray-500">Optional JSON array of region/country codes for automated routing.</p>
      </div>

      <div className="flex gap-4 pt-4">
        <button type="submit" className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700">Create Provider</button>
        <Link href="/admin/providers" className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">Cancel</Link>
      </div>
    </form>
  )
}
