'use client'

import { useState } from 'react'
import Link from 'next/link'
import { setDefaultProvider, testDefaultProviderConnection, syncPlansFromDefaultProvider } from '@/lib/actions/provider-settings'

interface Provider {
  id: string
  name: string
  code: string
  type: string
  environment: string
  status: string
  supportsESIM: boolean
  supportsUsage: boolean
  supportsTopUp: boolean
  supportsSuspend: boolean
}

export function DefaultProviderCard({
  providers,
  defaultProviderId: initialDefaultId,
}: {
  providers: Provider[]
  defaultProviderId: string | null
}) {
  const [selectedId, setSelectedId] = useState(initialDefaultId || '')
  const [saveMsg, setSaveMsg] = useState<any>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncResult, setSyncResult] = useState<any>(null)
  const [syncing, setSyncing] = useState(false)

  const selectedProvider = providers.find(p => p.id === selectedId)

  async function handleSave() {
    if (!selectedId) return
    setSaving(true)
    setSaveMsg(null)
    const result = await setDefaultProvider(selectedId)
    setSaveMsg(result)
    setSaving(false)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    const result = await testDefaultProviderConnection()
    setTestResult(result)
    setTesting(false)
  }

  async function handleSync() {
    setSyncing(true)
    setSyncResult(null)
    const result = await syncPlansFromDefaultProvider()
    setSyncResult(result)
    setSyncing(false)
  }

  const noProviders = providers.length === 0

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Default Fallback Provider</h3>
        <p className="text-sm text-gray-600">
          Used when no other provider is matched via package link, pricing rules, region routing, or priority order
        </p>
      </div>

      {noProviders ? (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          No providers configured yet.{' '}
          <a href="/admin/providers/new" className="underline font-medium">Create a provider</a> first.
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="default_provider" className="block text-sm font-medium text-gray-700">
              Default Fallback Provider
            </label>
            <select
              id="default_provider"
              value={selectedId}
              onChange={e => { setSelectedId(e.target.value); setSaveMsg(null); setTestResult(null) }}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">-- Select a provider --</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </div>

            {!selectedId && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
              No default fallback provider selected. The routing engine will use the lowest-priority active provider.
            </div>
          )}

          {selectedProvider && !['ACTIVE', 'DEGRADED', 'TESTING'].includes(selectedProvider.status) && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              Selected fallback provider is inactive/offline. Routing will skip it.
            </div>
          )}

          {selectedProvider && (
            <div className="rounded-lg bg-gray-50 p-3 space-y-2">
              <DetailRow label="Name" value={selectedProvider.name} />
              <DetailRow label="Code" value={selectedProvider.code} mono />
              <DetailRow label="Type" value={selectedProvider.type} />
              <DetailRow label="Environment" value={selectedProvider.environment} />
              <DetailRow
                label="Status"
                value={selectedProvider.status}
                className={selectedProvider.status === 'ACTIVE' ? 'text-green-600' : 'text-red-600'}
              />
              <DetailRow
                label="Capabilities"
                value={[
                  selectedProvider.supportsESIM && 'eSIM',
                  selectedProvider.supportsUsage && 'Usage',
                  selectedProvider.supportsTopUp && 'TopUp',
                  selectedProvider.supportsSuspend && 'Suspend',
                ].filter(Boolean).join(', ') || 'None'}
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={handleSave}
              disabled={!selectedId || saving}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Default Provider'}
            </button>
            <button
              onClick={handleTest}
              disabled={!selectedId || testing}
              className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {testing ? 'Testing...' : 'Test Current Provider'}
            </button>
            <button
              onClick={handleSync}
              disabled={!selectedId || syncing}
              className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Plans From Current Provider'}
            </button>
          </div>

          {saveMsg && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                saveMsg.success
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {saveMsg.success ? saveMsg.message : saveMsg.error}
            </div>
          )}

          {testResult && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                testResult.success
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {testResult.success ? testResult.message : testResult.error}
            </div>
          )}

          {syncResult && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                syncResult.success
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {syncResult.success ? (
                <div>
                  <p className="font-medium">{syncResult.success}</p>
                  {syncResult.plans && syncResult.plans.length > 0 && (
                    <Link
                      href={selectedId ? `/admin/providers/${selectedId}?synced=true` : '#'}
                      className="mt-2 inline-block text-cyan-700 underline"
                    >
                      View and import plans in provider detail page →
                    </Link>
                  )}
                </div>
              ) : (
                syncResult.error
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string
  value: string
  mono?: boolean
  className?: string
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-medium ${mono ? 'font-mono' : ''} ${className || ''}`}>
        {value}
      </span>
    </div>
  )
}
