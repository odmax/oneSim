import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { toggleProviderStatus, testProviderConnection } from '@/lib/actions/providers'
import { syncProviderPlans } from '@/lib/actions/provider-sync'
import { previewSync, applySafeSync } from '@/lib/actions/provider-sync-preview'
import { DeletePackageButton } from '@/components/admin/providers/DeletePackageButton'
import { PlanImportTable } from '@/components/admin/providers/PlanImportTable'
import ProviderWalletCard from '@/components/admin/providers/ProviderWalletCard'
import { ProviderAuthPanel } from '@/components/admin/providers/ProviderAuthPanel'
import { SetupWizard } from '@/components/admin/providers/SetupWizard'
import { ProviderLifecycleActions } from '@/components/admin/providers/ProviderLifecycleActions'
import ProviderCertificationWizard from '@/components/admin/providers/ProviderCertificationWizard'
import { ProviderHealthCards, ProviderCapabilityMatrix } from '@/components/admin/providers/ProviderHealthCards'
import { detectUrlMismatch } from '@/lib/providers/url-resolver'
import { SaveAsTemplateButton } from '@/components/admin/providers/SaveAsTemplateButton'
import { getProviderAuthStatus } from '@/lib/actions/provider-auth'
import { getRecentHealthLogs, type HealthEvent } from '@/lib/services/providers/health-monitor'
import { inferProviderCapabilities } from '@/lib/providers/capabilities'
import { getProviderCapabilities, CAPABILITY_LABELS, CAPABILITY_COLORS, providerSupports } from '@/lib/providers/capabilities/index'
import { ProviderActionButton, ActionForm } from '@/components/admin/providers/ActionButtons'
import { MappingValidator } from '@/components/admin/providers/MappingValidator'
import { TestPurchasePanel } from '@/components/admin/providers/TestPurchasePanel'
import { requiresTravelDateForPackage } from '@/lib/providers/travel-date-utils'
import { TelnaDiscoveryPanel } from '@/components/admin/providers/telna/TelnaDiscoveryPanel'
import { ProviderBalanceCard } from '@/components/admin/providers/ProviderBalanceCell'
import { ProviderRoamingProfilesCard } from '@/components/admin/providers/ProviderRoamingProfilesCard'
import { RoutingSimulator } from '@/components/admin/providers/RoutingSimulator'

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

export default async function ProviderDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string; synced?: string; setup?: string; tab?: string; preview?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: params.id } })
  if (!provider) redirect('/admin/providers?error=Provider+not+found')

  const authStatus = await getProviderAuthStatus(provider.id).catch(() => ({ hasToken: false, isConnected: false, status: 'error' as const }))
  const healthLogs: HealthEvent[] = await getRecentHealthLogs(provider.id, 10).catch(() => [])

  // Safely normalize provider config for rendering
  const safeConfig: Record<string, string> = {}
  const rawConfig = (provider.config || {}) as Record<string, unknown>
  try {
    for (const [k, v] of Object.entries(rawConfig || {})) {
      safeConfig[k] = typeof v === 'string' ? v : String(v ?? '')
    }
  } catch { /* malformed config */ }
  // Ensure configurationFields is always an array
  const safeConfigFields: any[] = (() => {
    try {
      const cf = rawConfig.configurationFields
      if (Array.isArray(cf)) return cf
      if (typeof cf === 'string') { const p = JSON.parse(cf); return Array.isArray(p) ? p : [] }
    } catch { /* malformed */ }
    return []
  })()
  const hasCredentials = !!(safeConfig.username || safeConfig.userName)

  const packageCount = await prisma.providerPackage.count({ where: { providerId: provider.id } }).catch(() => 0)
  const wallet = (provider.code === 'AIRHUB' || provider.code === 'CHOICE')
    ? await prisma.providerWallet.findUnique({ where: { providerId: provider.id } }).catch(() => null)
    : null
  const walletTransactions = wallet
    ? await prisma.providerWalletTransaction.findMany({ where: { providerId: provider.id }, orderBy: { occurredAt: 'desc' }, take: 50 }).catch(() => [])
    : []
  const importedPackages = await prisma.providerPackage.findMany({
    where: { providerId: provider.id },
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

  // Preview sync
  let previewData: any = null
  if (searchParams?.preview === 'true') {
    const preview = await previewSync(provider.id)
    if ('error' in preview) syncError = preview.error
    else previewData = preview
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
        {(provider.config as any)?.providerMode === 'TEMPLATE' && (
          <p className="text-xs text-gray-400 mt-1">
            Template-driven · Config keys: {Object.keys((provider.config as any) || {}).filter(k => !k.startsWith('_')).join(', ') || 'none'}
          </p>
        )}
        {detectUrlMismatch(provider.environment, provider.apiBaseUrl, provider.authUrl).hasMismatch && (
          <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
            {detectUrlMismatch(provider.environment, provider.apiBaseUrl, provider.authUrl).message}
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="mb-6 flex gap-1 border-b border-gray-200">
        <Link
          href={`/admin/providers/${provider.id}?tab=overview`}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            (searchParams?.tab || 'overview') === 'overview'
              ? 'border-b-2 border-cyan-600 text-cyan-700'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Overview
        </Link>
        {provider.adapterStrategy === 'TELNA' && (
          <Link
            href={`/admin/providers/${provider.id}?tab=discovery`}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              searchParams?.tab === 'discovery'
                ? 'border-b-2 border-cyan-600 text-cyan-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Telna Discovery
          </Link>
        )}
      </div>

      {/* Discovery Tab Content */}
      {(searchParams?.tab === 'discovery') ? (
        <>
          {provider.adapterStrategy === 'TELNA' ? (
            <TelnaDiscoveryPanel providerId={provider.id} />
          ) : (
            <div className="rounded-lg border bg-orange-50 p-6 text-center text-sm text-orange-700">
              Discovery is not available for this provider type.
            </div>
          )}
        </>
      ) : null}

      {/* Overview Tab Content */}
      {(!searchParams?.tab || searchParams?.tab === 'overview') ? (<>

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
          configValues={safeConfig}
          requiredConfigFields={(provider.requiredConfigFields || []) as any[]}
          configurationFields={safeConfigFields}
          credentialsConfigured={hasCredentials}
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

          {/* Capability Framework Badges */}
          {(() => {
            const declaredCaps = getProviderCapabilities(provider)
            if (declaredCaps.length === 0) return null
            return (
              <div className="mt-4 border-t pt-3">
                <p className="text-xs font-medium text-gray-500 mb-2">Declared Capabilities</p>
                <div className="flex flex-wrap gap-1">
                  {declaredCaps.map(cap => (
                    <span key={cap} className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${CAPABILITY_COLORS[cap] || 'bg-gray-100 text-gray-600'}`}>
                      {CAPABILITY_LABELS[cap] || cap}
                    </span>
                  ))}
                </div>
              </div>
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

      {/* Running Balance */}
      <div className="mb-6">
        <ProviderBalanceCard providerId={provider.id} />
      </div>

      {/* AirHub/Choice Wallet (Phase 5C) */}
      {(provider.code === 'AIRHUB' || provider.code === 'CHOICE') && (
        <div className="mb-6">
          <ProviderWalletCard
            providerId={provider.id}
            providerCode={provider.code}
            initialBalance={wallet?.balance ?? null}
            initialCurrency={wallet?.currency ?? null}
            initialStatus={wallet?.syncStatus ?? null}
            initialLastSync={wallet?.lastSyncedAt?.toISOString() ?? null}
            initialError={wallet?.lastError ?? null}
            initialThreshold={wallet?.lowBalanceThreshold ?? null}
            initialTransactions={walletTransactions as any[]}
          />
        </div>
      )}

      {/* Roaming Profiles */}
      <div className="mb-6">
        <ProviderRoamingProfilesCard providerId={provider.id} />
      </div>

      {/* Routing Simulator */}
      <div className="mb-6">
        <RoutingSimulator />
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
      {providerSupports(provider, 'CATALOG_SYNC') ? (
      <div className="mb-6 rounded-lg border bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Sync Plans</h3>
            <p className="text-sm text-gray-600">Fetch and import retail plans from this provider</p>
          </div>
          <div className="flex gap-2">
            <Link
              href={`/admin/providers/${provider.id}?preview=true`}
              className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50"
            >
              Preview Sync
            </Link>
            <Link
              href={`/admin/providers/${provider.id}?synced=true`}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Sync Plans
            </Link>
          </div>
        </div>

        {previewData && (
          <div className="mb-4 rounded-lg border border-cyan-200 bg-cyan-50 p-4">
            <h4 className="text-sm font-semibold text-cyan-800 mb-2">Sync Preview — {previewData.totalIncoming} incoming plans</h4>
            <div className="grid grid-cols-5 gap-2 text-center text-xs mb-3">
              <div className="rounded bg-white p-2"><p className="text-gray-500">New</p><p className="text-lg font-bold text-emerald-600">{previewData.newCount}</p></div>
              <div className="rounded bg-white p-2"><p className="text-gray-500">Updated</p><p className="text-lg font-bold text-amber-600">{previewData.updatedCount}</p></div>
              <div className="rounded bg-white p-2"><p className="text-gray-500">Unchanged</p><p className="text-lg font-bold text-gray-600">{previewData.unchangedCount}</p></div>
              <div className="rounded bg-white p-2"><p className="text-gray-500">Removed</p><p className="text-lg font-bold text-red-600">{previewData.removedCount}</p></div>
              <div className="rounded bg-white p-2"><p className="text-gray-500">Duplicates</p><p className="text-lg font-bold text-purple-600">{previewData.duplicateCount}</p></div>
            </div>
            <p className="text-xs text-cyan-700">No data written. Click Sync Plans to apply changes, or use safe sync modes.</p>
          </div>
        )}

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
                  <span className="text-gray-500">Request Endpoint:</span><span className="break-all text-[10px]">{syncDiagnostics.endpoint || syncDiagnostics.baseUrl || '—'}</span>
                  <span className="text-gray-500">Plan List Path:</span><span className="break-all">{syncDiagnostics.planListPath || '—'}</span>
                  <span className="text-gray-500">Response List Key:</span><span>{syncDiagnostics.responseListKey || '—'}</span>
                  <span className="text-gray-500">Token Placement:</span><span>{syncDiagnostics.tokenPlacement || '—'}</span>
                  <span className="text-gray-500">Token Present:</span><span>{syncDiagnostics.tokenPresent ? `Yes (${syncDiagnostics.tokenLength} chars)` : 'No'}</span>
                  <span className="text-gray-500">HTTP Status:</span><span>{syncDiagnostics.responseStatus || '—'}</span>
                  <span className="text-gray-500">Response Keys:</span><span className="break-all">{(syncDiagnostics.responseKeys || []).join(', ') || '—'}</span>
                  <span className="text-gray-500">Resolved Array Length:</span><span>{syncDiagnostics.resolvedArrayLength || 0}</span>
                  <span className="text-gray-500">Mapped Packages:</span><span>{syncDiagnostics.mappedPackageCount || 0}</span>
                  <span className="text-gray-500">Created:</span><span className="text-emerald-600">{syncDiagnostics.imported || 0}</span>
                  <span className="text-gray-500">Updated:</span><span className="text-amber-600">{syncDiagnostics.updated || 0}</span>
                  <span className="text-gray-500">Skipped:</span><span className="text-gray-400">{syncDiagnostics.skipped || 0}</span>
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
      ) : (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
          <p className="text-sm text-gray-500">Catalog Sync is not supported by this provider.</p>
        </div>
      )}

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
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-purple-700">{pkg.providerPlanCode || <span className="text-gray-400">—</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-indigo-700"><span className="text-gray-400">—</span></td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-600">{pkg.providerPlanId || 'N/A'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{pkg.dataGB}GB</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">${pkg.costPrice?.toString() || '0.00'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{pkg.sellingPrice ? `$${pkg.sellingPrice.toString()}` : <span className="text-amber-500">Not set</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${pkg.publishStatus === 'PUBLISHED' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>{pkg.publishStatus === 'PUBLISHED' ? 'Yes' : '—'}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <Link href={`/admin/provider-catalog`} className="text-blue-600 hover:text-blue-800">Catalog</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Test Purchase Panel */}
      {importedPackages.length > 0 && providerSupports(provider, 'PURCHASE') && (
        <div className="mt-6">
          <TestPurchasePanel
            providerId={provider.id}
            packages={importedPackages.map(p => ({
              id: p.id,
              name: p.name,
              dataGB: p.dataGB,
              validityDays: p.validityDays,
              priceUSD: p.sellingPrice || 0,
              providerPlanId: p.providerPlanId,
              requiresTravelDate: requiresTravelDateForPackage(p),
            }))}
            endpointMappings={provider.endpointMappings as Record<string, string> | null}
            requestMappings={provider.requestMappings as Record<string, any> | null}
            responseMappings={provider.responseMappings as Record<string, any> | null}
          />
        </div>
      )}
      </>)
        : null}
    </div>
  )
}
