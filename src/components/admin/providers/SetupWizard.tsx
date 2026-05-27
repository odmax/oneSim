'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CredentialFields } from './CredentialFields'
import { authenticateProvider, testProviderConnection, getProviderAuthStatus } from '@/lib/actions/provider-auth'

interface SetupWizardProps {
  providerId: string
  providerName: string
  providerType: string
  initialAuthType?: string | null
}

type WizardStep = 'credentials' | 'authenticate' | 'test' | 'sync' | 'complete'

const STEP_CONFIG: { key: WizardStep; label: string; icon: string }[] = [
  { key: 'credentials', label: 'Credentials', icon: '🔑' },
  { key: 'authenticate', label: 'Authenticate', icon: '🔐' },
  { key: 'test', label: 'Test', icon: '🔌' },
  { key: 'sync', label: 'Sync Plans', icon: '📡' },
  { key: 'complete', label: 'Complete', icon: '✅' },
]

export function SetupWizard({ providerId, providerName, providerType, initialAuthType }: SetupWizardProps) {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState<WizardStep>('credentials')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
  const [tokenPreview, setTokenPreview] = useState<string | null>(null)

  const stepIndex = STEP_CONFIG.findIndex(s => s.key === currentStep)

  async function handleAuthenticate(formData: FormData) {
    setLoading(true)
    setStatus(null)
    try {
      const result = await authenticateProvider(providerId, formData)
      if (result.success) {
        if ((result as any).needsAccountSelection) {
          setStatus({ type: 'info', message: `${(result as any).accounts?.length || ''} accounts found. Select the correct account on the provider dashboard.` })
          setCurrentStep('complete')
        } else {
          setStatus({ type: 'success', message: result.message || 'Authentication successful' })
          setCurrentStep('test')
        }
      } else {
        const err = (result as any).error || 'Authentication failed'
        setStatus({ type: 'error', message: err })
      }
    } catch (e: any) {
      setStatus({ type: 'error', message: e.message || 'Something went wrong' })
    } finally {
      setLoading(false)
    }
  }

  async function handleTestConnection() {
    setLoading(true)
    setStatus(null)
    try {
      const result = await testProviderConnection(providerId)
      if (result.success) {
        setStatus({ type: 'success', message: result.message || 'Connection successful' })
        setCurrentStep('sync')
      } else {
        setStatus({ type: 'error', message: (result as any).error || 'Connection test failed' })
      }
    } catch (e: any) {
      setStatus({ type: 'error', message: e.message || 'Test failed' })
    } finally {
      setLoading(false)
    }
  }

  function handleSyncPlans() {
    setLoading(true)
    setStatus({ type: 'info', message: 'Navigating to plan sync...' })
    router.push(`/admin/providers/${providerId}?tab=sync`)
    setCurrentStep('complete')
    setLoading(false)
  }

  function handleSkipSync() {
    setCurrentStep('complete')
    setStatus({ type: 'success', message: 'Provider setup complete. You can sync plans later from the provider detail page.' })
  }

  function handleFinish() {
    router.push(`/admin/providers/${providerId}?success=Provider+setup+complete`)
  }

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEP_CONFIG.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
              i === stepIndex ? 'bg-cyan-600 text-white' :
              i < stepIndex ? 'bg-green-100 text-green-800' :
              'bg-gray-100 text-gray-400'
            }`}>
              <span>{s.icon}</span>
              <span>{s.label}</span>
            </div>
            {i < STEP_CONFIG.length - 1 && (
              <div className={`h-px w-6 ${i < stepIndex ? 'bg-green-400' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>

      {status && (
        <div className={`rounded-lg border p-4 text-sm ${
          status.type === 'success' ? 'border-green-200 bg-green-50 text-green-800' :
          status.type === 'error' ? 'border-red-200 bg-red-50 text-red-800' :
          'border-cyan-200 bg-cyan-50 text-cyan-800'
        }`}>
          {status.message}
        </div>
      )}

      {/* Step 1: Credentials */}
      {currentStep === 'credentials' && (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Enter Credentials</h3>
            <p className="text-sm text-gray-500 mt-1">
              Enter your provider credentials to authenticate.
            </p>
          </div>
          <form action={handleAuthenticate} className="space-y-4">
            <CredentialFields type={providerType} authType={initialAuthType} />
            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
              >
                {loading ? 'Processing...' : 'Save & Test'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Step 2: Authenticate (auth happens in step 1; this is for status display) */}
      {currentStep === 'authenticate' && (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Authentication</h3>
            <p className="text-sm text-gray-500 mt-1">Verifying your credentials with the provider.</p>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-cyan-200 bg-cyan-50 p-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-600 border-t-transparent" />
            <span className="text-sm text-cyan-800">Authenticating...</span>
          </div>
        </div>
      )}

      {/* Step 3: Test Connection */}
      {currentStep === 'test' && (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Test Connection</h3>
            <p className="text-sm text-gray-500 mt-1">
              Verify the provider endpoint is reachable with the stored credentials.
            </p>
          </div>
          {tokenPreview && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs font-medium text-gray-500 mb-1">Stored Token</p>
              <p className="text-sm font-mono text-gray-700">{tokenPreview}</p>
            </div>
          )}
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={loading}
            className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {loading ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
      )}

      {/* Step 4: Sync Plans */}
      {currentStep === 'sync' && (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Sync Plans</h3>
            <p className="text-sm text-gray-500 mt-1">
              Import available plans and pricing from the provider.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleSyncPlans}
              disabled={loading}
              className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {loading ? 'Redirecting...' : 'Sync Plans Now'}
            </button>
            <button
              type="button"
              onClick={handleSkipSync}
              className="rounded-lg border border-gray-300 bg-white px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Skip — I will do this later
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Complete */}
      {currentStep === 'complete' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
            <div className="text-3xl mb-2">✅</div>
            <h3 className="text-lg font-semibold text-green-800">Setup Complete</h3>
            <p className="text-sm text-green-700 mt-1">
              {providerName} is now configured and ready to use.
            </p>
          </div>
          <button
            type="button"
            onClick={handleFinish}
            className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            View Provider Dashboard
          </button>
        </div>
      )}
    </div>
  )
}
