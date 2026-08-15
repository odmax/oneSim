'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getProviderAuthStatus, authenticateProvider, testProviderConnection, selectProviderAccount, clearProviderCredentials, getProviderAccountConfig } from '@/lib/actions/provider-auth'
import { CredentialFields } from './CredentialFields'

interface AuthStatusData {
  hasToken: boolean
  isConnected: boolean
  status: string
  lastSuccessfulConnection?: string
  lastFailedConnection?: string
  lastError?: string | null
  errorCount?: number | null
  providerStatus?: string
  type?: string
  authMethod?: string | null
  lastAuthenticatedAt?: string | null
}

interface AccountInfo {
  account: string
  accountName: string
  token?: string
}

interface ProviderAuthPanelProps {
  providerId: string
  providerType: string
  providerName: string
  authType?: string | null
  authUrl?: string | null
  initialStatus?: AuthStatusData
  configValues?: Record<string, string>
  credentialsConfigured?: boolean
  requiredConfigFields?: Array<{ name: string; label: string; type: string; required: boolean; placeholder?: string }>
  configurationFields?: Array<{ key: string; label: string; type: string; required?: boolean; secret?: boolean; placeholder?: string; options?: { value: string; label: string }[]; group?: string; default?: string }>
  /** Provider-neutral auth mode from the connector (e.g. STATIC_KEY_ID). */
  authMode?: string
  /** Derived action label (Save & Verify / Save & Authenticate / Connect / Verify Connection). */
  authActionLabel?: string
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  connected: { label: 'Connected', color: 'text-green-700 bg-green-50 border-green-200', icon: '🟢' },
  configured: { label: 'Configured (untested)', color: 'text-yellow-700 bg-yellow-50 border-yellow-200', icon: '🟡' },
  not_configured: { label: 'Not Configured', color: 'text-gray-700 bg-gray-50 border-gray-200', icon: '⚪' },
  token_expired: { label: 'Token Expired', color: 'text-red-700 bg-red-50 border-red-200', icon: '🔴' },
  failed: { label: 'Connection Failed', color: 'text-red-700 bg-red-50 border-red-200', icon: '🔴' },
  unknown: { label: 'Unknown', color: 'text-gray-700 bg-gray-50 border-gray-200', icon: '❓' },
}

export function ProviderAuthPanel({ providerId, providerType, providerName, authType, authUrl, initialStatus, configValues = {}, requiredConfigFields = [], configurationFields, credentialsConfigured, authMode, authActionLabel }: ProviderAuthPanelProps) {
  const router = useRouter()
  const [authStatus, setAuthStatus] = useState<AuthStatusData>(initialStatus || { hasToken: false, isConnected: false, status: 'unknown' })
  const [accountConfig, setAccountConfig] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [showAuthForm, setShowAuthForm] = useState(!initialStatus?.hasToken)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [result, setResult] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const statusCfg = STATUS_CONFIG[authStatus.status] || STATUS_CONFIG.unknown

  async function refreshStatus() {
    const data = await getProviderAuthStatus(providerId)
    setAuthStatus(data)
    const cfg = await getProviderAccountConfig(providerId)
    setAccountConfig(cfg)
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  async function handleAuthenticate(formData: FormData) {
    setLoading(true)
    setResult(null)
    try {
      const r: any = await authenticateProvider(providerId, formData)
      if (r.success) {
        if (r.needsAccountSelection && r.accounts?.length > 1) {
          setAccounts(r.accounts)
          setShowAccountPicker(true)
          setResult({ type: 'info', message: `${r.accounts.length} accounts found. Select the correct account below.` })
        } else {
          setResult({ type: 'success', message: r.message || 'Authentication successful' })
          setShowAuthForm(false)
        }
        await refreshStatus()
        router.refresh()
      } else {
        setResult({ type: 'error', message: r.error || 'Authentication failed' })
      }
    } catch (e: any) {
      setResult({ type: 'error', message: e.message || 'Something went wrong' })
    } finally {
      setLoading(false)
    }
  }

  async function handleSelectAccount(accountId: string) {
    setLoading(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.set('accountId', accountId)
      const r = await selectProviderAccount(providerId, formData)
      if (r.success) {
        setResult({ type: 'success', message: r.message || 'Account selected' })
        setShowAccountPicker(false)
        setAccounts([])
        await refreshStatus()
        router.refresh()
      } else {
        setResult({ type: 'error', message: r.error || 'Failed to select account' })
      }
    } catch (e: any) {
      setResult({ type: 'error', message: e.message || 'Something went wrong' })
    } finally {
      setLoading(false)
    }
  }

  async function handleClearCredentials() {
    if (!confirm('Clear all stored credentials and token for this provider?')) return
    setLoading(true)
    setResult(null)
    try {
      const r = await clearProviderCredentials(providerId)
      if (r.success) {
        setResult({ type: 'success', message: r.message || 'Credentials cleared' })
        setShowAuthForm(true)
        setShowAccountPicker(false)
        await refreshStatus()
        router.refresh()
      } else {
        setResult({ type: 'error', message: r.error || 'Failed to clear credentials' })
      }
    } catch (e: any) {
      setResult({ type: 'error', message: e.message || 'Something went wrong' })
    } finally {
      setLoading(false)
    }
  }

  const [testDiagnostics, setTestDiagnostics] = useState<any>(null)

  async function handleTestConnection() {
    setLoading(true)
    setResult(null)
    setTestDiagnostics(null)
    try {
      const r: any = await testProviderConnection(providerId)
      if (r.success) {
        setResult({ type: 'success', message: r.message || 'Connection test passed' })
        if (r.diagnostics) setTestDiagnostics(r.diagnostics)
        await refreshStatus()
      } else {
        setResult({ type: 'error', message: r.error || 'Connection test failed' })
        if (r.diagnostics) setTestDiagnostics(r.diagnostics)
        await refreshStatus()
      }
    } catch (e: any) {
      setResult({ type: 'error', message: e.message || 'Test failed' })
    } finally {
      setLoading(false)
    }
  }

  function getTimeDisplay(iso?: string): string {
    if (!iso) return 'Never'
    return new Date(iso).toLocaleString()
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Authentication</h3>
        <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${statusCfg.color}`}>
          <span>{statusCfg.icon}</span>
          <span>{statusCfg.label}</span>
        </div>
      </div>

      {/* Status details */}
      <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-500">Last Successful Connection</p>
          <p className="font-medium text-gray-900">{getTimeDisplay(authStatus.lastSuccessfulConnection)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-500">Last Failed Connection</p>
          <p className="font-medium text-gray-900">{getTimeDisplay(authStatus.lastFailedConnection)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-500">Error Count</p>
          <p className="font-medium text-gray-900">{authStatus.errorCount ?? 0}</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-500">Last Error</p>
          <p className="font-medium text-gray-900 truncate" title={authStatus.lastError || ''}>{authStatus.lastError || 'None'}</p>
        </div>
      </div>

      {/* Environment warning */}
      {accountConfig?.envMismatch && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          Environment mismatch: provider is set to &quot;{accountConfig.environment}&quot; but was authenticated in &quot;{accountConfig.envAtAuth}&quot;.
          Re-authenticate in the correct environment.
        </div>
      )}
      {accountConfig?.portMismatch && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          Port mismatch: {accountConfig.environment} environment expects port {accountConfig.expectedPort} but base URL uses port {accountConfig.baseUrlPort}.
        </div>
      )}
      {accountConfig?.envWarning && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">{accountConfig.envWarning}</div>
      )}

      {result && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${result.type === 'success' ? 'border-green-200 bg-green-50 text-green-800' : result.type === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-cyan-200 bg-cyan-50 text-cyan-800'}`}>
          {result.message}
        </div>
      )}

      {/* Credentials not configured warning */}
      {!authStatus.hasToken && !credentialsConfigured && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Credentials not configured. Click &quot;Configure Connection&quot; below to add username and password.
        </div>
      )}

      {/* Test diagnostics */}
      {testDiagnostics && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs font-mono space-y-1">
          {testDiagnostics.errorClassification && (
            <p className="text-gray-500">
              Error Classification:{' '}
              <span className={`font-semibold ${
                testDiagnostics.errorClassification === 'NETWORK_ERROR' ? 'text-red-700' :
                testDiagnostics.errorClassification === 'HTTP_404' ? 'text-orange-700' :
                testDiagnostics.errorClassification === 'HTTP_400' ? 'text-yellow-700' :
                'text-gray-800'
              }`}>
                {testDiagnostics.errorClassification}
              </span>
            </p>
          )}
          {testDiagnostics.retryAttempted && testDiagnostics.retryExplanation && (
            <p className="text-blue-700">Retry: {testDiagnostics.retryExplanation}</p>
          )}
          {testDiagnostics.connectorClass && (
            <p className="text-gray-500">Connector: <span className="text-gray-800 font-semibold">{testDiagnostics.connectorClass}</span></p>
          )}
          {testDiagnostics.accountId && testDiagnostics.accountId !== '—' && (
            <p className="text-gray-500">Selected Account: <span className="text-cyan-700 font-semibold">{testDiagnostics.accountName || testDiagnostics.accountId}</span></p>
          )}
          {testDiagnostics.accountId && testDiagnostics.accountId !== '—' && (
            <p className="text-gray-500">Account ID: <span className="text-gray-800">{testDiagnostics.accountId}</span></p>
          )}
          {testDiagnostics.method && <p className="text-gray-500">Method: <span className="text-gray-800">{testDiagnostics.method}</span></p>}
          {testDiagnostics.baseUrl && <p className="text-gray-500">Base URL: <span className="text-gray-800">{testDiagnostics.baseUrl}</span></p>}
          {testDiagnostics.authUrl && testDiagnostics.authUrl !== '—' && <p className="text-gray-500">Auth URL: <span className="text-gray-800">{testDiagnostics.authUrl}</span></p>}
          {testDiagnostics.path && <p className="text-gray-500">Path: <span className="text-gray-800">{testDiagnostics.path}</span></p>}
          {testDiagnostics.finalUrl && <p className="text-gray-500">Final URL: <span className="text-gray-800 break-all">{testDiagnostics.finalUrl}</span></p>}
          {testDiagnostics.responseStatus != null && (
            <p className="text-gray-500">Response Status: <span className={`${testDiagnostics.responseStatus >= 200 && testDiagnostics.responseStatus < 300 ? 'text-green-700' : 'text-red-700'} font-semibold`}>{testDiagnostics.responseStatus}</span></p>
          )}
          {testDiagnostics.responseContentType && <p className="text-gray-500">Content-Type: <span className="text-gray-800">{testDiagnostics.responseContentType}</span></p>}
          {testDiagnostics.responseBody && <p className="text-gray-500">Response Body: <span className="text-gray-400 break-all text-2xs" dangerouslySetInnerHTML={{ __html: testDiagnostics.responseBody }}></span></p>}
          {testDiagnostics.tokenPlacement && <p className="text-gray-500">Token Placement: <span className="text-gray-800">{testDiagnostics.tokenPlacement}</span></p>}
          {testDiagnostics.authType && <p className="text-gray-500">Auth Type: <span className="text-gray-800">{testDiagnostics.authType}</span></p>}
          {testDiagnostics.authHeaderPresent != null && <p className="text-gray-500">Auth Header Sent: <span className={`font-semibold ${testDiagnostics.authHeaderPresent ? 'text-green-700' : 'text-gray-500'}`}>{testDiagnostics.authHeaderPresent ? 'Yes' : 'No'}</span></p>}
          {testDiagnostics.tokenReplaced != null && <p className="text-gray-500">Token Replaced: <span className={`font-semibold ${testDiagnostics.tokenReplaced ? 'text-green-700' : 'text-red-700'}`}>{testDiagnostics.tokenReplaced ? 'Yes' : 'No'}</span></p>}
          {testDiagnostics.requestTimeoutMs && <p className="text-gray-500">Request Timeout: <span className="text-gray-800">{testDiagnostics.requestTimeoutMs}ms</span></p>}
          {testDiagnostics.latencyMs != null && <p className="text-gray-500">Latency: <span className="text-gray-800">{testDiagnostics.latencyMs}ms</span></p>}
          {testDiagnostics.warnings && testDiagnostics.warnings.length > 0 && (
            <div className="text-yellow-700">
              <p className="font-semibold">Warnings:</p>
              {testDiagnostics.warnings.map((w: string, i: number) => <p key={i} className="ml-2">• {w}</p>)}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              const lines = [
                `Error Classification: ${testDiagnostics.errorClassification || '—'}`,
                `Connector: ${testDiagnostics.connectorClass || '—'}`,
                `Method: ${testDiagnostics.method || '—'}`,
                `Base URL: ${testDiagnostics.baseUrl || '—'}`,
                `Auth URL: ${testDiagnostics.authUrl || '—'}`,
                `Path: ${testDiagnostics.path || '—'}`,
                `Final URL: ${testDiagnostics.finalUrl || '—'}`,
                `Token Placement: ${testDiagnostics.tokenPlacement || '—'}`,
                `Auth Type: ${testDiagnostics.authType || '—'}`,
                `Auth Header Sent: ${testDiagnostics.authHeaderPresent != null ? (testDiagnostics.authHeaderPresent ? 'Yes' : 'No') : '—'}`,
                `Token Replaced: ${testDiagnostics.tokenReplaced != null ? (testDiagnostics.tokenReplaced ? 'Yes' : 'No') : '—'}`,
                `Response Status: ${testDiagnostics.responseStatus ?? '—'}`,
                `Content-Type: ${testDiagnostics.responseContentType || '—'}`,
                `Response Body: ${(testDiagnostics.responseBody || '—').replace(/<[^>]*>/g, '').substring(0, 300)}`,
                `Request Timeout: ${testDiagnostics.requestTimeoutMs || '15000'}ms`,
                `Latency: ${testDiagnostics.latencyMs != null ? testDiagnostics.latencyMs + 'ms' : '—'}`,
                `Retry Attempted: ${testDiagnostics.retryAttempted ? 'Yes' : 'No'}`,
                `Retry Explanation: ${testDiagnostics.retryExplanation || '—'}`,
                `Account: ${testDiagnostics.accountName || '—'} (${testDiagnostics.accountId || '—'})`,
                `Token: ${testDiagnostics.apiToken || '—'}`,
                `Environment: ${testDiagnostics.environment || '—'}`,
              ]
              if (testDiagnostics.warnings?.length) {
                lines.push(`Warnings: ${testDiagnostics.warnings.join(', ')}`)
              }
              navigator.clipboard.writeText(lines.join('\n'))
            }}
            className="mt-2 text-xs text-cyan-600 hover:text-cyan-800 underline"
          >
            Copy Debug Info
          </button>
        </div>
      )}

      {/* Account picker */}
      {showAccountPicker && accounts.length > 0 && (
        <div className="mb-4 rounded-lg border border-cyan-200 bg-cyan-50 p-4">
          <p className="mb-3 text-sm font-medium text-cyan-900">Select Provider Account</p>
          <p className="mb-3 text-xs text-cyan-700">Multiple accounts found. Select which one to use for this provider.</p>
          <div className="space-y-2">
            {accounts.map((acc, i) => (
              <button
                key={acc.account}
                type="button"
                onClick={() => handleSelectAccount(acc.account)}
                disabled={loading}
                className="w-full rounded-lg border border-cyan-300 bg-white px-4 py-3 text-left text-sm hover:bg-cyan-50 disabled:opacity-50"
              >
                <span className="font-medium text-cyan-900">{acc.accountName}</span>
                <span className="ml-2 font-mono text-xs text-gray-500">ID: {acc.account}</span>
                <span className="ml-2 font-mono text-xs text-gray-400">Token: {acc.token || '—'}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => { setShowAccountPicker(false); setAccounts([]) }} className="mt-3 text-xs text-cyan-600 hover:underline">
            Cancel
          </button>
        </div>
      )}

      {/* Auth form */}
      {showAuthForm && !showAccountPicker && (
        <form action={handleAuthenticate} className="mb-4 space-y-4 border-t pt-4">
          <p className="text-sm text-gray-600">
            Configure provider connection details.
          </p>
          <CredentialFields authType={authType} values={configValues || {}} extraFields={requiredConfigFields} configurationFields={configurationFields} />
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {loading ? 'Processing...' : (authActionLabel || 'Save & Authenticate')}
            </button>
            {authStatus.hasToken && (
              <button
                type="button"
                onClick={() => setShowAuthForm(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {/* Config details */}
      {accountConfig && authStatus.hasToken && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowConfig(!showConfig)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            {showConfig ? 'Hide' : 'Show'} connection details
          </button>
          {showConfig && (
            <div className="mt-2 rounded-lg bg-gray-50 p-3 font-mono text-xs space-y-1">
              <p className="text-gray-500">Selected Account: <span className="text-cyan-700 font-semibold">{accountConfig.selectedAccountName || '—'}</span></p>
              <p className="text-gray-500">Account ID: <span className="text-gray-800">{accountConfig.selectedAccountId || '—'}</span></p>
              <p className="text-gray-500">API Token: <span className="text-gray-800">{accountConfig.apiToken || '—'}</span></p>
              <p className="text-gray-500">Base URL: <span className="text-gray-800">{accountConfig.apiBaseUrl || '—'}</span></p>
              <p className="text-gray-500">Auth URL: <span className="text-gray-800">{accountConfig.authUrl || '—'}</span></p>
              <p className="text-gray-500">Environment: <span className="text-gray-800">{accountConfig.environment}</span></p>
              <p className="text-gray-500">Strategy: <span className="text-gray-800">{accountConfig.adapterStrategy || '—'}</span></p>
              {accountConfig.accounts?.length > 1 && (
                <p className="text-gray-500">Available Accounts: <span className="text-gray-800">{accountConfig.accounts.length}</span></p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        {authStatus.hasToken && !showAuthForm && !showAccountPicker && (
          <>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={loading}
              className="rounded-lg border border-cyan-600 bg-white px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50 disabled:opacity-50"
            >
              {loading ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              type="button"
              onClick={() => setShowAuthForm(true)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Re-authenticate &amp; Choose Account
            </button>
            <button
              type="button"
              onClick={handleClearCredentials}
              disabled={loading}
              className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Clear Credentials
            </button>
          </>
        )}
        {!authStatus.hasToken && (
          <button
            type="button"
            onClick={() => setShowAuthForm(true)}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            Set Up Authentication
          </button>
        )}
        {authStatus.hasToken && accountConfig?.accounts?.length > 1 && !showAuthForm && (
          <button
            type="button"
            onClick={async () => {
              setShowAuthForm(true)
            }}
            className="rounded-lg border border-purple-300 bg-white px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50"
          >
            Switch Account
          </button>
        )}
      </div>
    </div>
  )
}
