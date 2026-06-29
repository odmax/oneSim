'use client'

import { useState } from 'react'
import { STEP_LABELS, advanceCertification, resetCertification } from '@/lib/actions/provider-certification'

const STEP_ORDER = ['CONFIGURING', 'AUTHENTICATED', 'CONNECTED', 'PLANS_SYNCED', 'PLANS_IMPORTED', 'PURCHASE_TESTED', 'USAGE_TESTED', 'TOPUP_TESTED', 'CERTIFIED']

export default function ProviderCertificationWizard({ providerId, currentStatus }: { providerId: string; currentStatus: string }) {
  const [status, setStatus] = useState(currentStatus)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const currentIdx = STEP_ORDER.indexOf(status)
  const isCertified = status === 'CERTIFIED'
  const isFailed = status === 'FAILED'

  async function handleAdvance(target: string) {
    setLoading(target); setError(null)
    try {
      // If moving multiple steps, advance one at a time
      const targetIdx = STEP_ORDER.indexOf(target)
      let current = status
      for (let i = STEP_ORDER.indexOf(current); i < targetIdx; i++) {
        const next = STEP_ORDER[i + 1]
        const res = await advanceCertification(providerId)
        if (!res.success) { setError(res.error || 'Step failed'); setLoading(null); return }
        current = next
      }
      setStatus(target)
    } catch (e: any) { setError(e.message || 'Error') }
    setLoading(null)
  }

  async function handleReset() {
    setLoading('reset'); setError(null)
    await resetCertification(providerId)
    setStatus('CONFIGURING')
    setLoading(null)
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-900">Certification Progress</h3>
        <div className="flex items-center gap-2">
          {isCertified && <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">✓ Certified</span>}
          {isFailed && <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">✗ Failed</span>}
          {status !== 'CONFIGURING' && (
            <button onClick={handleReset} disabled={loading === 'reset'}
              className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50">Reset</button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {STEP_ORDER.map((step, i) => {
          const stepIdx = STEP_ORDER.indexOf(status)
          const isPast = i < stepIdx
          const isCurrent = i === stepIdx
          const isPending = i > stepIdx

          return (
            <div key={step} className="flex items-center gap-3 py-1.5">
              {/* Step circle */}
              <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
                isPast ? 'bg-emerald-100 text-emerald-600' :
                isCurrent && !isFailed ? 'bg-blue-100 text-blue-600 ring-2 ring-blue-300' :
                isFailed && step === status ? 'bg-red-100 text-red-600' :
                'bg-gray-50 text-gray-300'
              }`}>
                {isPast ? '✓' : isFailed && step === status ? '✗' : i + 1}
              </div>

              {/* Step label */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${isPending ? 'text-gray-300' : isCurrent && isFailed ? 'text-red-700' : 'text-gray-700'}`}>
                  {STEP_LABELS[step] || step}
                </p>
              </div>

              {/* Action button — only for current step or next actionable step */}
              {(isCurrent && !isFailed) && (
                <button onClick={() => handleAdvance(step)} disabled={loading === step}
                  className="shrink-0 rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {loading === step ? '...' : i === 0 ? 'Start' : 'Mark Done'}
                </button>
              )}

              {(isCurrent && isFailed) && (
                <button onClick={() => handleAdvance(step)} disabled={loading === step}
                  className="shrink-0 rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  Retry
                </button>
              )}

              {isPending && i === stepIdx + 1 && !isFailed && (
                <button onClick={() => handleAdvance(step)} disabled={loading === step}
                  className="shrink-0 rounded bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-200 disabled:opacity-50">
                  {loading === step ? '...' : 'Skip →'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</div>
      )}
    </div>
  )
}
