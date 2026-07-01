import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { toggleProviderStatus, testProviderConnection } from '@/lib/actions/providers'
import { syncProviderPlans } from '@/lib/actions/provider-sync'
import { DeletePackageButton } from '@/components/admin/providers/DeletePackageButton'
import { PlanImportTable } from '@/components/admin/providers/PlanImportTable'
import { ProviderAuthPanel } from '@/components/admin/providers/ProviderAuthPanel'
import { SetupWizard } from '@/components/admin/providers/SetupWizard'
import { ProviderLifecycleActions } from '@/components/admin/providers/ProviderLifecycleActions'
import ProviderCertificationWizard from '@/components/admin/providers/ProviderCertificationWizard'
import { ProviderHealthCards, ProviderCapabilityMatrix } from '@/components/admin/providers/ProviderHealthCards'
import { SaveAsTemplateButton } from '@/components/admin/providers/SaveAsTemplateButton'
import { getProviderAuthStatus } from '@/lib/actions/provider-auth'
import { getRecentHealthLogs, type HealthEvent } from '@/lib/services/providers/health-monitor'
import { inferProviderCapabilities } from '@/lib/providers/capabilities'
import { ProviderActionButton, ActionForm } from '@/components/admin/providers/ActionButtons'
import { MappingValidator } from '@/components/admin/providers/MappingValidator'
import { TestPurchasePanel } from '@/components/admin/providers/TestPurchasePanel'

function maskApiToken(token: string | null): string {
  if (!token) return ''
  return '••••••••'
}

function healthEventIcon(type: string): string {
  switch (type) {
    case 'AUTH_FAILURE': return '🔴'
    case 'CONNECTION_TEST': return '🔌'
    case 'SYNC': return '📡'
    case 'ACTIVATION_FAILURE': return '❌'
    case 'TOKEN_EXPIRED': return '⏰'
    case 'TOKEN_REFRESHED': return '🔄'
    case 'REQUEST_SUCCESS': return '✅'
    default: return '•'
  }
}

export default async function ProviderDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string; synced?: string; setup?: string; tab?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: params.id } })
  if (!provider) redirect('/admin/providers?error=Provider+not+found')

  const authStatus = await getProviderAuthStatus(provider.id)
  const healthLogs: HealthEvent[] = await getRecentHealthLogs(provider.id, 10)

  const packageCount = await prisma.eSIMPackage.count({ where: { providerId: provider.id } })
  const importedPackages = await prisma.eSIMPackage.findMany({
    where: { providerId: provider.id },
    include: { _count: { select: { purchases: true, topUpRecords: true } } },
    orderBy: { createdAt: 'desc' },
  })
  // annual markup — deprecated
  const importedPlanIds = new Set(importedPackages.filter(p => p.providerPlanId).map(p => p.providerPlanId!))

  // Sync plans if requested
  let fetchedPlans: any[] | null = null
  let syncError: string | null = null
  let syncDiagnostics: any = null
  let inferredCapabilities: string[] | null = null
  if (searchParams?.synced === 'true') {
    const result = await syncProviderPlans(provider.id)
    if ('error' in result) {
      syncError = result.error || null
      syncDiagnostics = (result as any).diagnostics || null
    } else if ('plans' in result) {
      fetchedPlans = result.plans as any[]
      syncDiagnostics = (result as any).diagnostics || null
      inferredCapabilities = (result as any).inferredCapabilities || null
    }
  }

  // Show setup wizard on first creation
  const showSetup = searchParams?.setup === 'true'

  if (showSetup) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <Link href={`/admin/providers/${provider.id}`} className="text-sm text-cyan-600 hover:underline">← Skip to Provider Dashboard</Link>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">Set Up: {provider.name}</h2>
          <p className="text-gray-600">Complete the authentication and testing wizard to get started.</p>
        </div>
        <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
          <SetupWizard
            providerId={provider.id}
            providerName={provider.name}
            providerType={provider.type}
            initialAuthType={provider.authType}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/providers" className="text-sm text-cyan-600 hover:underline">← Back to Providers</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">{provider.name}</h2>
        <p className="text-gray-600">Code: <span className="font-mono">{provider.code}</span></p>
      </div>

      {/* Tab Navigation */}
      <div className="mb-6 flex gap-1 border-b border-gray-200">
        <span className="px-4 py-2 text-sm font-medium border-b-2 border-cyan-600 text-cyan-700">
          Overview
        </span>
      </div>

      {searchParams?.success && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}
      {searchParams?.error || syncError ? (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams?.error || '')}{syncError || ''}</div>
      ) : null}
      {inferredCapabilities && inferredCapabilities.length > 0 && (
        <div className="mb-6 rounded-lg border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-800">
          Auto-detected capabilities from config: <span className="font-semibold">{inferredCapabilities.join(', ')}</span>
        </div>
      )}

      {/* Auth Panel + Provider Details */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        <ProviderAuthPanel
          providerId={provider.id}
          providerType={provider.type}
          providerName={provider.name}
          authType={provider.authType}
          authUrl={provider.authUrl}
          initialStatus={authStatus}
          configValues={(provider.config || {}) as Record<string, string>}
          requiredConfigFields={(provider.requiredConfigFields || []) as any[]}
          configurationFields={((provider.config as any)?.configurationFields || []) as any[]}
        />

        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Provider Details</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium text-gray-900">{provider.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Code</dt><dd className="font-mono font-medium text-gray-900">{provider.code}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Type</dt><dd><span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 bg-blue-100 text-blue-800`}>{provider.type}</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd><span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
              provider.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
              provider.status === 'DEGRADED' ? 'bg-orange-100 text-orange-800' :
              provider.status === 'TESTING' ? 'bg-blue-100 text-blue-800' :
              provider.status === 'MAINTENANCE' ? 'bg-purple-100 text-purple-800' :
              provider.status === 'ARCHIVED' ? 'bg-gray-100 text-gray-800' :
              'bg-red-100 text-red-800'
            }`}>{provider.status}</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Default Fallback</dt><dd>{provider.isDefaultFallback ? <span className="inline-flex rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">Yes</span> : 'No'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Environment</dt><dd className="font-medium text-gray-900">{provider.environment}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Priority</dt><dd className="font-medium text-gray-900">{provider.priority} {provider.isDefaultFallback && <span className="text-amber-600 text-xs">(Fallback)</span>}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">API Base URL</dt><dd className="font-mono text-sm text-gray-900">{provider.apiBaseUrl || <span className="text-gray-400">Not set</span>}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Auth URL</dt><dd className="font-mono text-sm text-gray-900">{provider.authUrl || <span className="text-gray-400">Same as API Base URL</span>}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">API Token</dt><dd className="font-mono text-sm text-gray-500">{maskApiToken(provider.apiToken) || <span className="text-gray-400">Not set</span>}</dd></div>
            {provider.config && (
              <div className="flex justify-between"><dt className="text-gray-500">Config</dt><dd className="font-mono text-xs text-gray-500 max-w-[200px] truncate" title={JSON.stringify(provider.config)}>{JSON.stringify(provider.config)}</dd></div>
            )}
            <div className="flex justify-between"><dt className="text-gray-500">Linked Packages</dt><dd className="font-medium text-gray-900">{packageCount}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Created</dt><dd className="text-gray-600">{provider.createdAt.toLocaleDateString()}</dd></div>
          </dl>
        </div>
      </div>

      {/* Capabilities + Actions */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Capabilities</h3>
          {(() => {
            const caps = inferProviderCapabilities(provider)
            const entries: { key: string; label: string; yes: boolean }[] = [
              { key: 'supportsESIM', label: 'eSIM Provisioning', yes: caps.supportsESIM },
              { key: 'supportsPlanSync', label: 'Plan Sync', yes: caps.supportsPlanSync },
              { key: 'supportsQRCode', label: 'QR Code', yes: caps.supportsQRCode },
              { key: 'supportsTopUp', label: 'Top-Up', yes: caps.supportsTopUp },
              { key: 'supportsRenewals', label: 'Renewals', yes: caps.supportsRenewals },
              { key: 'supportsUsage', label: 'Usage Tracking', yes: caps.supportsUsage },
              { key: 'supportsUsageSync', label: 'Usage Sync', yes: caps.supportsUsageSync },
              { key: 'supportsSuspend', label: 'Suspend', yes: caps.supportsSuspend },
              { key: 'supportsSuspendResume', label: 'Suspend/Resume', yes: caps.supportsSuspendResume },
              { key: 'supportsWallet', label: 'Wallet', yes: caps.supportsWallet },
              { key: 'supportsOrderLookup', label: 'Order Lookup', yes: caps.supportsOrderLookup },
              { key: 'supportsInventory', label: 'Inventory', yes: caps.supportsInventory },
              { key: 'supportsCountryCatalog', label: 'Country Catalog', yes: caps.supportsCountryCatalog },
              { key: 'supportsWebhookPush', label: 'Webhook Push', yes: caps.supportsWebhookPush },
              { key: 'supportsTemplates', label: 'Bundle Templates', yes: caps.supportsTemplates },
            ]
            return (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {entries.map(entry => (
                    <div key={entry.key} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                      <span className="text-sm text-gray-700">{entry.label}</span>
                      {entry.yes ? (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">Yes</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">No</span>
                      )}
                    </div>
                  ))}
                </div>
                {caps.detectedFrom.endpointMappings.length > 0 && (
                  <p className="mt-3 text-xs text-gray-400">
                    Detected from endpointMappings: {caps.detectedFrom.endpointMappings.join(', ')}
                  </p>
                )}
                {caps.detectedFrom.pathFields.length > 0 && (
                  <p className="mt-1 text-xs text-gray-400">
                    Detected from path fields: {caps.detectedFrom.pathFields.join(', ')}
                  </p>
                )}
              </>
            )
          })()}

          {/* Mapping Validator */}
          <div className="mt-4">
            <MappingValidator
              endpointMappings={provider.endpointMappings as Record<string, string> | null}
              requestMappings={provider.requestMappings as Record<string, any> | null}
              responseMappings={provider.responseMappings as Record<string, any> | null}
              purchaseWorkflow={(provider.config as any)?.purchaseWorkflow || (provider.config as any)?.purchase_workflow}
            />
          </div>

          {provider.authType && (
            <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <span className="font-medium">Auth:</span> {provider.authType}
              {provider.apiVersion && <><span className="text-gray-400">|</span><span className="font-medium">API:</span> {provider.apiVersion}</>}
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href={`/admin/providers/${provider.id}/edit`} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Edit Provider</Link>
            <ActionForm action={async (fd) => { 'use server'; await toggleProviderStatus(provider.id) }} label="Cycle Status" loadingLabel="Cycling..." color="outline" />
            <ActionForm action={async () => { 'use server'; const result = await testProviderConnection(provider.id); if (!result.success) throw new Error(result.error) }} label="Test Connection" loadingLabel="Testing..." color="cyan" />
            <Link href={`/admin/providers/${provider.id}/diagnostics`} className="rounded-lg border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50">
              Diagnostics
            </Link>
            <SaveAsTemplateButton providerId={provider.id} providerName={provider.name} />
          </div>
        </div>

        {/* Health Metrics */}
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Health &amp; Connectivity</h3>
          {provider.lastSuccessfulConnection || provider.lastFailedConnection || provider.errorCount != null ? (
            <dl className="space-y-3 text-sm">
              {provider.lastSuccessfulConnection && <div className="flex justify-between"><dt className="text-gray-500">Last Successful Connection</dt><dd className="font-medium text-green-700">{provider.lastSuccessfulConnection.toLocaleString()}</dd></div>}
              {provider.lastFailedConnection && <div className="flex justify-between"><dt className="text-gray-500">Last Failed Connection</dt><dd className="font-medium text-red-700">{provider.lastFailedConnection.toLocaleString()}</dd></div>}
              {provider.errorCount != null && <div className="flex justify-between"><dt className="text-gray-500">Error Count</dt><dd className={`font-medium ${provider.errorCount > 0 ? 'text-red-700' : 'text-green-700'}`}>{provider.errorCount}</dd></div>}
              {provider.lastError && <div className="flex justify-between"><dt className="text-gray-500">Last Error</dt><dd className="font-mono text-xs text-red-600 max-w-[200px] truncate" title={provider.lastError}>{provider.lastError}</dd></div>}
              {provider.activationSuccessRate != null && <div className="flex justify-between"><dt className="text-gray-500">Activation Success Rate</dt><dd className="font-medium text-gray-900">{provider.activationSuccessRate}%</dd></div>}
              {provider.averageActivationTimeMs != null && <div className="flex justify-between"><dt className="text-gray-500">Avg Activation Time</dt><dd className="font-medium text-gray-900">{provider.averageActivationTimeMs}ms</dd></div>}
              {provider.lastSyncAt && <div className="flex justify-between"><dt className="text-gray-500">Last Sync</dt><dd className="font-medium text-gray-900">{provider.lastSyncAt.toLocaleString()}<br/><span className="text-xs text-gray-500">{provider.lastSyncResult || ''}{provider.lastSyncCount != null ? ` (${provider.lastSyncCount} plans)` : ''}</span></dd></div>}
            </dl>
          ) : (
            <p className="text-sm text-gray-500">No health data recorded yet. Run a connection test to populate metrics.</p>
          )}

          {/* Recent Health Events */}
          {healthLogs.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wider">Recent Events</p>
              <div className="space-y-1.5">
                {healthLogs.slice(-5).reverse().map((event, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5">{healthEventIcon(event.eventType)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-700 truncate">{event.message || event.eventType}</p>
                      <p className="text-gray-400">{new Date(event.timestamp).toLocaleString()}</p>
                    </div>
                    {event.durationMs !== undefined && (
                      <span className="text-gray-400 whitespace-nowrap">{event.durationMs}ms</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Routing Visibility */}
      <div className="mb-6 rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Routing Visibility</h3>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between"><dt className="text-gray-500">Routing Priority</dt><dd className="font-medium text-gray-900">{provider.priority}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Default Fallback</dt><dd>{provider.isDefaultFallback ? <span className="inline-flex rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">Yes</span> : 'No'}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Status for Routing</dt><dd>
             <span className={`inline-flex rounded-full px-2 text-xs font-semibold ${
               ['ACTIVE', 'DEGRADED', 'TESTING'].includes(provider.status)
                 ? 'bg-green-100 text-green-800'
                 : provider.status === 'ARCHIVED' ? 'bg-gray-100 text-gray-500' : 'bg-red-100 text-red-800'
             }`}>{provider.status === 'ACTIVE' || provider.status === 'DEGRADED' || provider.status === 'TESTING' ? 'Routes traffic' : provider.status === 'ARCHIVED' ? 'Archived — skipped by router' : 'Skipped by router'}</span>
          </dd></div>
          {provider.regions && Array.isArray(provider.regions as any) && (provider.regions as any[]).length > 0 && (
            <div className="flex justify-between"><dt className="text-gray-500">Regions</dt><dd className="font-mono text-xs text-gray-600">{(provider.regions as string[]).join(', ')}</dd></div>
          )}
        </dl>
      </div>

      {/* Health Cards + Capability Matrix */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <ProviderHealthCards provider={provider} />
        <ProviderCapabilityMatrix provider={provider} />
      </div>

      {/* Certification Wizard */}
      <div className="mb-6">
        <ProviderCertificationWizard providerId={provider.id} currentStatus={provider.certificationStatus || 'CONFIGURING'} />
      </div>

      {/* Lifecycle Management */}
      <div className="mb-6">
        <ProviderLifecycleActions
          providerId={provider.id}
          providerName={provider.name}
          providerStatus={provider.status}
          isSuperAdmin={session.user.internalAdminRole === 'SUPER_ADMIN'}
          isDefaultFallback={provider.isDefaultFallback}
        />
      </div>

      {/* Annual markup warning — removed; pricing is manual per product */}

      {/* Sync Plans Section */}
      <div className="mb-6 rounded-lg border bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Sync Plans</h3>
            <p className="text-sm text-gray-600">Fetch and import retail plans from this provider</p>
          </div>
          <div className="flex gap-2">
            <Link
              href={`/admin/providers/${provider.id}?synced=true`}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Sync Plans
            </Link>
          </div>
        </div>

        {fetchedPlans && fetchedPlans.length > 0 && (
          <div>
            <p className="mb-3 text-sm text-gray-600">Showing {fetchedPlans.length} plans from {provider.name}:</p>
            <PlanImportTable
              plans={fetchedPlans}
              importedPlanIds={importedPlanIds}
              importedPackages={importedPackages}
              providerId={provider.id}
              providerName={provider.name}
            />
          </div>
        )}

        {fetchedPlans && syncDiagnostics && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <details>
              <summary className="cursor-pointer text-sm font-medium text-gray-700">Sync Diagnostics</summary>
              <div className="mt-3 space-y-2 text-xs font-mono">
                {syncDiagnostics.lowCountWarning && fetchedPlans.length < 10 && (
                  <div className="rounded bg-orange-50 p-2 text-orange-700 font-semibold not-italic">
                    Warning: Only {fetchedPlans.length} plans fetched — expected more for this provider type. Check API response or parsing.
                  </div>
                )}
                <div className="grid grid-cols-[200px_1fr] gap-x-4 gap-y-1">
                  <span className="text-gray-500">Protocol / Strategy:</span><span>{syncDiagnostics.adapterStrategy || '—'}</span>
                  <span className="text-gray-500">Provider Type:</span><span>{syncDiagnostics.providerType}</span>
                  <span className="text-gray-500">Base URL:</span><span>{syncDiagnostics.baseUrl || '—'}</span>
                  <span className="text-gray-500">Plan List Path:</span><span className="break-all">{syncDiagnostics.planListPath || '—'}</span>
                  <span className="text-gray-500">Response List Key:</span><span>{syncDiagnostics.responseListKey || '—'}</span>
                  <span className="text-gray-500">Token Placement:</span><span>{syncDiagnostics.tokenPlacement || '—'}</span>
                  <span className="text-gray-500">Token Present:</span><span>{syncDiagnostics.tokenPresent ? `Yes (${syncDiagnostics.tokenLength} chars)` : 'No'}</span>
                  <span className="text-gray-500">Fetched:</span><span>{syncDiagnostics.fetchedCount}</span>
                  <span className="text-gray-500">Already Imported:</span><span>{fetchedPlans.filter(p => importedPlanIds.has(p.id)).length}</span>
                  <span className="text-gray-500">New (ready to import):</span><span>{fetchedPlans.length - fetchedPlans.filter(p => importedPlanIds.has(p.id)).length}</span>
                  {syncDiagnostics.providerError && <><span className="text-gray-500">Error:</span><span className="text-red-600">{syncDiagnostics.providerError}</span></>}
                </div>
              </div>
            </details>
          </div>
        )}

        {!fetchedPlans && !syncError && !searchParams?.synced && (
          <p className="text-sm text-gray-500">Click "Sync Plans" to fetch retail plans from this provider.</p>
        )}

        {syncError && (
          <p className="text-sm text-red-600">{syncError}</p>
        )}
      </div>

      {/* Imported Packages */}
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Imported Packages ({importedPackages.length})</h3>

        {importedPackages.length === 0 ? (
          <p className="text-sm text-gray-500">No packages have been imported from this provider yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">SKU</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Package Code</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Plan ID</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Data</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Cost Price</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Selling Price</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Active</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {importedPackages.map(pkg => (
                  <tr key={pkg.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">{pkg.name}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-purple-700">{pkg.sku || <span className="text-gray-400">—</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-indigo-700">{pkg.packageCode || <span className="text-gray-400">—</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-600">{pkg.providerPlanId || 'N/A'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{pkg.dataGB}GB</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">${pkg.costPriceUSD?.toString() || '0.00'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">${pkg.priceUSD.toString()}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${pkg.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>{pkg.isActive ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <Link href={`/admin/packages/${pkg.id}/edit`} className="text-blue-600 hover:text-blue-800">Configure</Link>
                      <span className="mx-2 text-gray-300">|</span>
                      <DeletePackageButton packageId={pkg.id} hasPurchases={(pkg as any)._count?.purchases > 0 || (pkg as any)._count?.topUpRecords > 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Test Purchase Panel */}
      {importedPackages.length > 0 && (
        <div className="mt-6">
          <TestPurchasePanel
            providerId={provider.id}
            packages={importedPackages.map(p => ({
              id: p.id,
              name: p.name,
              dataGB: p.dataGB,
              validityDays: p.validityDays,
              priceUSD: p.priceUSD,
              providerPlanId: p.providerPlanId,
            }))}
            endpointMappings={provider.endpointMappings as Record<string, string> | null}
            requestMappings={provider.requestMappings as Record<string, any> | null}
            responseMappings={provider.responseMappings as Record<string, any> | null}
          />
        </div>
      )}
    </div>
  )
}
