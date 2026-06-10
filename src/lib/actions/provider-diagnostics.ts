'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getAdapterForType, isTemplateDrivenProvider, buildAdapter } from '@/lib/providers/adapter-manager'

export interface DiagnosticResult {
  test: string
  status: 'pass' | 'fail' | 'skip' | 'error'
  message: string
  details?: any
  latencyMs?: number
}

export async function runProviderDiagnostics(providerId: string): Promise<DiagnosticResult[]> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return []

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return [{ test: 'Provider Lookup', status: 'error', message: 'Provider not found' }]

  const results: DiagnosticResult[] = []

  // 1. Provider config check
  results.push({
    test: 'Configuration',
    status: provider.apiBaseUrl ? 'pass' : 'fail',
    message: provider.apiBaseUrl
      ? `API Base URL: ${maskUrl(provider.apiBaseUrl)}, Auth: ${provider.authType || 'bearer_token'}`
      : 'No API Base URL configured',
  })

  // 2. Connection test via adapter
  try {
    const adapter = isTemplateDrivenProvider(provider)
      ? await buildAdapter(provider)
      : await getAdapterForType(provider.type, { apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken, providerId: provider.id })
    if (adapter) {
      const start = Date.now()
      const connResult = await adapter.testConnection()
      const latency = Date.now() - start
      results.push({
        test: 'Connection Test',
        status: connResult.success ? 'pass' : 'fail',
        message: connResult.success ? (connResult.data?.message || 'Connected') : (connResult.error?.message || 'Connection failed'),
        latencyMs: latency,
        details: connResult,
      })

      if (connResult.success) {
        // 3. Plan sync test
        const syncStart = Date.now()
        const syncResult = await adapter.syncPlans()
        results.push({
          test: 'Plan Sync',
          status: syncResult.success ? 'pass' : 'fail',
          message: syncResult.success ? `Fetched ${syncResult.data?.length || 0} plans` : (syncResult.error?.message || 'Sync failed'),
          latencyMs: Date.now() - syncStart,
        })

        // 4. Activation simulation
        results.push({
          test: 'Activation Endpoint',
          status: 'skip',
          message: 'Activation tested during live ordering only',
        })

        // 5. Suspend/Resume capability
        results.push({
          test: 'Suspend/Resume',
          status: provider.supportsSuspend || provider.supportsSuspendResume ? 'pass' : 'skip',
          message: provider.supportsSuspend || provider.supportsSuspendResume
            ? 'Suspend/Resume enabled'
            : 'Not configured for this provider',
        })

        // 6. Usage query
        results.push({
          test: 'Usage Query',
          status: provider.supportsUsage ? 'pass' : 'skip',
          message: provider.supportsUsage ? 'Usage tracking enabled' : 'Not configured for this provider',
        })
      }
    } else {
      results.push({
        test: 'Adapter',
        status: 'error',
        message: `No adapter available for provider type: ${provider.type}`,
      })
    }
  } catch (e: any) {
    results.push({
      test: 'Adapter Error',
      status: 'error',
      message: e.message || 'Unexpected error running diagnostics',
    })
  }

  // 7. Health metrics
  if (provider.lastSuccessfulConnection || provider.lastFailedConnection || provider.errorCount != null || provider.activationSuccessRate != null) {
    const healthEntries: string[] = []
    if (provider.lastSuccessfulConnection) healthEntries.push(`Last OK: ${provider.lastSuccessfulConnection.toISOString()}`)
    if (provider.lastFailedConnection) healthEntries.push(`Last Fail: ${provider.lastFailedConnection.toISOString()}`)
    if (provider.errorCount != null) healthEntries.push(`Errors: ${provider.errorCount}`)
    if (provider.activationSuccessRate != null) healthEntries.push(`Activation Rate: ${provider.activationSuccessRate}%`)
    if (provider.averageActivationTimeMs != null) healthEntries.push(`Avg Act. Time: ${provider.averageActivationTimeMs}ms`)
    if (provider.lastSyncAt) healthEntries.push(`Last Sync: ${provider.lastSyncAt.toISOString()} (${provider.lastSyncResult || 'OK'})`)
    if (provider.lastError) healthEntries.push(`Last Error: ${provider.lastError}`)
    results.push({
      test: 'Health Metrics',
      status: 'pass',
      message: healthEntries.join(' | '),
      details: {
        lastSuccessfulConnection: provider.lastSuccessfulConnection,
        lastFailedConnection: provider.lastFailedConnection,
        activationSuccessRate: provider.activationSuccessRate,
        averageActivationTimeMs: provider.averageActivationTimeMs,
        errorCount: provider.errorCount,
        lastError: provider.lastError,
        lastSyncAt: provider.lastSyncAt,
        lastSyncResult: provider.lastSyncResult,
      },
    })
  } else {
    results.push({
      test: 'Health Metrics',
      status: 'skip',
      message: 'No health data recorded yet. Run a connection test first.',
    })
  }

  // 8. Provider status check
  results.push({
    test: 'Provider Status',
    status: provider.status === 'ACTIVE' ? 'pass' : provider.status === 'DEGRADED' ? 'fail' : provider.status === 'TESTING' ? 'skip' : 'error',
    message: `Status: ${provider.status}${provider.isDefaultFallback ? ' (Default Fallback)' : ''}${provider.regions ? ` | Regions: ${JSON.stringify(provider.regions)}` : ''}`,
  })

  // 9. Audit log
  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PROVIDER_DIAGNOSTICS_RUN',
      entity: 'Provider',
      entityId: provider.code,
      details: `Ran diagnostics on "${provider.name}": ${results.filter(r => r.status === 'pass').length}/${results.length} passed`,
    },
  })

  return results
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/[^/]+$/, '/***')}`
  } catch {
    return url.substring(0, 30) + '...'
  }
}
