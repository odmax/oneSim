'use client'

import { createTemplate, updateTemplate } from '@/lib/actions/provider-templates'

export function TemplateForm({ initial }: { initial?: any }) {
  return (
    <form action={initial ? updateTemplate.bind(null, initial.id) : createTemplate} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Template Name</label>
          <input id="name" name="name" type="text" required
            defaultValue={initial?.name || ''}
            placeholder="e.g. Standard URL Token Provider"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="connectorType" className="block text-sm font-medium text-gray-700">Connector Type</label>
          <select id="connectorType" name="connectorType" defaultValue={initial?.connectorType || 'STANDARD'}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="STANDARD">STANDARD — Path-based connector</option>
            <option value="URL_TOKEN">URL_TOKEN — Token in URL path</option>
            <option value="HEADER_TOKEN">HEADER_TOKEN — Token in Authorization header</option>
            <option value="REST_CATALOG">REST_CATALOG — Standard REST API catalog</option>
            <option value="MOCK">MOCK — Simulated provider</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description (optional)</label>
        <textarea id="description" name="description" rows={2}
          defaultValue={initial?.description || ''}
          placeholder="What provider type is this template for?"
          className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="authType" className="block text-sm font-medium text-gray-700">Auth Type</label>
          <select id="authType" name="authType" defaultValue={initial?.authType || 'bearer_token'}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="bearer_token">Bearer Token</option>
            <option value="api_key">API Key</option>
            <option value="basic">Basic Auth</option>
            <option value="credentials">Username / Password</option>
          </select>
        </div>
        <div>
          <label htmlFor="tokenPlacement" className="block text-sm font-medium text-gray-700">Token Placement</label>
          <select id="tokenPlacement" name="tokenPlacement" defaultValue={initial?.tokenPlacement || 'URL_PATH'}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="URL_PATH">URL Path</option>
            <option value="BEARER_HEADER">Bearer Header</option>
            <option value="API_KEY_HEADER">API Key Header</option>
            <option value="BASIC_AUTH">Basic Auth</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="defaultBaseUrl" className="block text-sm font-medium text-gray-700">Default Base URL (optional)</label>
          <input id="defaultBaseUrl" name="defaultBaseUrl" type="url"
            defaultValue={initial?.defaultBaseUrl || ''}
            placeholder="https://api.provider.com/v1"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="defaultAuthUrl" className="block text-sm font-medium text-gray-700">Default Auth URL (optional)</label>
          <input id="defaultAuthUrl" name="defaultAuthUrl" type="url"
            defaultValue={initial?.defaultAuthUrl || ''}
            placeholder="https://auth.provider.com/token"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      <details className="rounded-lg border border-gray-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">Endpoint Paths (optional)</summary>
        <div className="space-y-3 px-4 pb-4 pt-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600">Plan List Path</label>
              <input name="defaultPlanListPath" type="text" defaultValue={initial?.defaultPlanListPath || ''} placeholder="/api/v1/plans"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Activation Path</label>
              <input name="defaultActivationPath" type="text" defaultValue={initial?.defaultActivationPath || ''} placeholder="/api/v1/activate"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600">Status Path</label>
              <input name="defaultStatusPath" type="text" defaultValue={initial?.defaultStatusPath || ''} placeholder="/api/v1/status"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Usage Path</label>
              <input name="defaultUsagePath" type="text" defaultValue={initial?.defaultUsagePath || ''} placeholder="/api/v1/usage"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600">Suspend Path</label>
              <input name="defaultSuspendPath" type="text" defaultValue={initial?.defaultSuspendPath || ''} placeholder="/api/v1/suspend"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Resume Path</label>
              <input name="defaultResumePath" type="text" defaultValue={initial?.defaultResumePath || ''} placeholder="/api/v1/resume"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Response List Key</label>
            <input name="defaultResponseListKey" type="text" defaultValue={initial?.defaultResponseListKey || ''} placeholder="data.plans"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
        </div>
      </details>

      <details className="rounded-lg border border-gray-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">Field Mappings (optional)</summary>
        <div className="space-y-3 px-4 pb-4 pt-3">
          <p className="text-xs text-gray-500">JSON object mapping plan fields: {`{"sku":"sku_field","name":"name_field","data_gb":"data_field","validity_days":"days_field","price_usd":"price_field"}`}</p>
          <textarea name="defaultFieldMappings" rows={4}
            defaultValue={initial?.defaultFieldMappings ? JSON.stringify(initial.defaultFieldMappings, null, 2) : '{\n  "sku": "",\n  "name": "",\n  "data_gb": "",\n  "validity_days": "",\n  "price_usd": ""\n}'}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </div>
      </details>

      <details className="rounded-lg border border-gray-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">Default Capabilities (optional)</summary>
        <div className="space-y-3 px-4 pb-4 pt-3">
          <p className="text-xs text-gray-500">JSON object defining which features are enabled by default.</p>
          <textarea name="defaultCapabilities" rows={4}
            defaultValue={initial?.defaultCapabilities ? JSON.stringify(initial.defaultCapabilities, null, 2) : '{\n  "supportsESIM": true,\n  "supportsUsage": false,\n  "supportsQRCode": false\n}'}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </div>
      </details>

      <div className="flex gap-4 pt-4">
        <button type="submit" className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700">
          {initial ? 'Update Template' : 'Create Template'}
        </button>
        <a href="/admin/provider-templates" className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">
          Cancel
        </a>
      </div>
    </form>
  )
}
