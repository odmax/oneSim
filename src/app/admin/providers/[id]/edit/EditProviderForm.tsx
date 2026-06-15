'use client'

import { useState } from 'react'
import Link from 'next/link'
import { updateProvider } from '@/lib/actions/providers'

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        <span className="text-gray-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}

export function EditProviderForm({ provider }: { provider: any }) {
  const fieldMappings = provider.fieldMappings || {}
  const endpointMappings = provider.endpointMappings || {}
  const activateEp = endpointMappings?.activate || {}

  return (
    <form action={updateProvider.bind(null, provider.id)} className="space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">Provider Name</label>
        <input id="name" name="name" type="text" required defaultValue={provider.name} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="code" className="block text-sm font-medium text-gray-700">Code</label>
          <input type="text" defaultValue={provider.code} className="mt-1 block w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-mono text-gray-500" readOnly />
          <p className="mt-1 text-xs text-gray-400">Code cannot be changed after creation.</p>
        </div>
        <div>
          <label htmlFor="type" className="block text-sm font-medium text-gray-700">Connector Type</label>
          <input type="text" defaultValue={provider.adapterStrategy || provider.type} className="mt-1 block w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 text-sm text-gray-500" readOnly />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="environment" className="block text-sm font-medium text-gray-700">Environment</label>
          <select id="environment" name="environment" defaultValue={provider.environment} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
        </div>
        <div>
          <label htmlFor="status" className="block text-sm font-medium text-gray-700">Status</label>
          <select id="status" name="status" defaultValue={provider.status} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="ACTIVE">Active</option>
            <option value="DEGRADED">Degraded</option>
            <option value="MAINTENANCE">Maintenance</option>
            <option value="TESTING">Testing</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="priority" className="block text-sm font-medium text-gray-700">Routing Priority</label>
          <input id="priority" name="priority" type="number" defaultValue={provider.priority} min={0} className="mt-1 block w-32 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label htmlFor="authType" className="block text-sm font-medium text-gray-700">Auth Type</label>
          <select id="authType" name="authType" defaultValue={provider.authType || 'bearer_token'} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="bearer_token">Bearer Token</option>
            <option value="api_key">API Key</option>
            <option value="basic">Basic Auth</option>
            <option value="credentials">Username / Password</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer hover:bg-gray-50">
          <input type="checkbox" name="isDefaultFallback" defaultChecked={provider.isDefaultFallback} className="rounded border-gray-300" />
          <span>Default Fallback Provider</span>
        </label>
      </div>

      <div>
        <label htmlFor="regions" className="block text-sm font-medium text-gray-700">Regions (JSON array)</label>
        <textarea id="regions" name="regions" rows={3} defaultValue={provider.regions ? JSON.stringify(provider.regions) : ''} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none" placeholder='["South Africa", "Nigeria", "Kenya"]' />
        <p className="mt-1 text-xs text-gray-500">Optional JSON array of region/country codes for automated routing.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="apiBaseUrl" className="block text-sm font-medium text-gray-700">API Base URL</label>
          <input id="apiBaseUrl" name="apiBaseUrl" type="url" defaultValue={provider.apiBaseUrl || ''} placeholder="https://api.provider.com/v1" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label htmlFor="authUrl" className="block text-sm font-medium text-gray-700">Auth URL (optional)</label>
          <input id="authUrl" name="authUrl" type="text" defaultValue={provider.authUrl || ''} placeholder="https://auth.provider.com/token or /relative/path" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-gray-400">Separate auth endpoint if different from API Base URL.</p>
        </div>
      </div>

      <div>
        <label htmlFor="apiToken" className="block text-sm font-medium text-gray-700">API Token / Key</label>
        <input id="apiToken" name="apiToken" type="password" placeholder={provider.apiToken ? 'Leave empty to keep current token' : 'Enter API token'} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        {provider.apiToken && <p className="mt-1 text-xs text-gray-500">Current token is masked. Enter a new value to replace it.</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="apiVersion" className="block text-sm font-medium text-gray-700">API Version</label>
          <input id="apiVersion" name="apiVersion" type="text" defaultValue={provider.apiVersion || 'v1'} placeholder="v1" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label htmlFor="tokenPlacement" className="block text-sm font-medium text-gray-700">Token Placement</label>
          <select id="tokenPlacement" name="tokenPlacement" defaultValue={provider.tokenPlacement || 'HEADER'} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="HEADER">Authorization Header</option>
            <option value="URL_PATH">URL Path</option>
            <option value="QUERY_PARAM">Query Parameter</option>
            <option value="NONE">No Token</option>
          </select>
        </div>
      </div>

      <Section title="Endpoint Paths — plan list, activation, status, usage, suspend, resume, top-up">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="planListPath" className="block text-xs font-medium text-gray-600 mb-1">Plan List Path</label>
            <input id="planListPath" name="planListPath" type="text" defaultValue={provider.planListPath || ''} placeholder="/plans or /api/v1/plans" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="activationPath" className="block text-xs font-medium text-gray-600 mb-1">Activation Path</label>
            <input id="activationPath" name="activationPath" type="text" defaultValue={provider.activationPath || ''} placeholder="/activate" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="statusPath" className="block text-xs font-medium text-gray-600 mb-1">Status Path</label>
            <input id="statusPath" name="statusPath" type="text" defaultValue={provider.statusPath || ''} placeholder="/status/{subscriptionId}" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="usagePath" className="block text-xs font-medium text-gray-600 mb-1">Usage Path</label>
            <input id="usagePath" name="usagePath" type="text" defaultValue={provider.usagePath || ''} placeholder="/usage/{iccid}" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="suspendPath" className="block text-xs font-medium text-gray-600 mb-1">Suspend Path</label>
            <input id="suspendPath" name="suspendPath" type="text" defaultValue={provider.suspendPath || ''} placeholder="/suspend/{subscriptionId}" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="resumePath" className="block text-xs font-medium text-gray-600 mb-1">Resume Path</label>
            <input id="resumePath" name="resumePath" type="text" defaultValue={provider.resumePath || ''} placeholder="/resume/{subscriptionId}" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="topUpPath" className="block text-xs font-medium text-gray-600 mb-1">Top-Up Path</label>
            <input id="topUpPath" name="topUpPath" type="text" defaultValue={provider.topUpPath || ''} placeholder="/topup/{subscriptionId}" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
        </div>
      </Section>

      <Section title="Response Mapping — list key and field mappings for plan sync">
        <div>
          <label htmlFor="responseListKey" className="block text-xs font-medium text-gray-600 mb-1">Response List Key</label>
          <input id="responseListKey" name="responseListKey" type="text" defaultValue={provider.responseListKey || ''} placeholder="data, results, bundle_template_list" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-gray-400">Dot path to the array in the API response (e.g. data.items, results)</p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">Plan Field Mappings — map provider JSON fields to OneSim fields</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">SKU field</label>
              <input name="fieldSku" type="text" defaultValue={fieldMappings.sku || 'sku'} placeholder="sku" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">Name field</label>
              <input name="fieldName" type="text" defaultValue={fieldMappings.name || 'name'} placeholder="name" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">Data (GB) field</label>
              <input name="fieldData" type="text" defaultValue={fieldMappings.data_gb || 'data_gb'} placeholder="data_gb" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">Validity (days) field</label>
              <input name="fieldValidity" type="text" defaultValue={fieldMappings.validity_days || 'validity_days'} placeholder="validity_days" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">Price (USD) field</label>
              <input name="fieldCost" type="text" defaultValue={fieldMappings.price_usd || 'price_usd'} placeholder="price_usd" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Activation Endpoint Mapping — method and body for activation">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="activationMethod" className="block text-xs font-medium text-gray-600 mb-1">HTTP Method</label>
            <select id="activationMethod" name="activationMethod" defaultValue={activateEp.method || 'POST'} className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
          <div>
            <label htmlFor="activationBodyTemplate" className="block text-xs font-medium text-gray-600 mb-1">Body Template (JSON)</label>
            <input id="activationBodyTemplate" name="activationBodyTemplate" type="text" defaultValue={activateEp.body ? JSON.stringify(activateEp.body) : ''} placeholder='{"sku": "{{sku}}", "email": "{{email}}"}' className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none" />
          </div>
        </div>
      </Section>

      <Section title="Capabilities — manually override which features this provider supports">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[
            { key: 'supportsESIM', label: 'eSIM Provisioning' },
            { key: 'supportsQRCode', label: 'QR Code' },
            { key: 'supportsUsage', label: 'Usage Tracking' },
            { key: 'supportsUsageSync', label: 'Usage Sync' },
            { key: 'supportsTopUp', label: 'Top-Up Support' },
            { key: 'supportsSuspend', label: 'Suspend' },
            { key: 'supportsSuspendResume', label: 'Suspend / Resume' },
            { key: 'supportsPools', label: 'Data Pools' },
            { key: 'supportsTemplates', label: 'Bundle Templates' },
            { key: 'supportsWebhookPush', label: 'Webhook Push' },
          ].map(cap => (
            <label key={cap.key} className="flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer hover:bg-gray-50">
              <input type="checkbox" name={cap.key} defaultChecked={!!provider[cap.key]} className="rounded border-gray-300" />
              <span>{cap.label}</span>
            </label>
          ))}
        </div>
      </Section>

      <div className="flex gap-4 pt-4">
        <button type="submit" className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700">Save Changes</button>
        <Link href={`/admin/providers/${provider.id}`} className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">Cancel</Link>
      </div>
    </form>
  )
}
