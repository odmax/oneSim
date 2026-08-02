'use client'

import { useState } from 'react'
import { testProviderPurchase } from '@/lib/actions/provider-test-purchase'

interface Package {
  id: string
  name: string
  dataGB: number
  validityDays: number
  priceUSD: { toString(): string }
  providerPlanId?: string | null
  requiresTravelDate?: boolean
}

export function TestPurchasePanel({ providerId, packages, endpointMappings, requestMappings, responseMappings }: {
  providerId: string
  packages: Package[]
  endpointMappings?: Record<string, string> | null
  requestMappings?: Record<string, any> | null
  responseMappings?: Record<string, any> | null
}) {
  const [providerPackageId, setProviderPackageId] = useState(packages[0]?.id || '')
  const [quantity, setQuantity] = useState(1)
  const [travelDate, setTravelDate] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')

  const selectedPackage = packages.find(p => p.id === providerPackageId)
  const hasValidPlanId = !!selectedPackage?.providerPlanId
  const requiresTravelDate = !!selectedPackage?.requiresTravelDate

  async function runTest() {
    if (!providerPackageId) return

    // Client-side guard: never dispatch without a travel date when the plan
    // requires one. Mirrors the server-side check in testProviderPurchase.
    if (requiresTravelDate && !travelDate) {
      setError('This package requires a Travel Date (YYYY-MM-DD). Enter one before running the test purchase.')
      setResult(null)
      return
    }
    if (travelDate && !/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
      setError('Travel Date must be in YYYY-MM-DD format.')
      setResult(null)
      return
    }

    setRunning(true)
    setError('')
    setResult(null)

    try {
      const res = await testProviderPurchase(providerId, providerPackageId, quantity, travelDate || undefined)
      if (res.success) {
        setResult(res)
      } else {
        setResult(res)
        setError(res.error || 'Test purchase failed')
      }
    } catch (e: any) {
      setError(e.message || 'Unexpected error')
    } finally {
      setRunning(false)
    }
  }

  async function handleCleanup(_orderId: string) {
    // Test purchase no longer creates database records — no cleanup needed
    setResult(null)
    setError('')
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Test Purchase</h3>
          <p className="text-xs text-gray-500">Run a real purchase against this provider to verify the full flow</p>
        </div>
        {result?.success && (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Passed</span>
        )}
        {result && !result.success && (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">Failed</span>
        )}
      </div>

      {/* Package selector */}
      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Test Package</label>
          <select value={providerPackageId} onChange={e => setProviderPackageId(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
            {packages.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.dataGB}GB, ${Number(p.priceUSD).toFixed(2)})</option>
            ))}
          </select>
          {selectedPackage?.providerPlanId && (
            <p className="text-[10px] text-gray-400 mt-1">Provider plan ID: {selectedPackage.providerPlanId}</p>
          )}
          {requiresTravelDate && (
            <p className="text-[10px] text-amber-600 mt-1">This plan requires a Travel Date before purchase</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
          <input type="number" min={1} max={10} value={quantity} onChange={e => setQuantity(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Travel Date {requiresTravelDate ? <span className="text-amber-600">(required)</span> : <span className="text-gray-400">(optional)</span>}
          </label>
          <input
            type="date"
            value={travelDate}
            required={requiresTravelDate}
            onChange={e => setTravelDate(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
          />
          <p className="text-[10px] text-gray-400 mt-1">Format YYYY-MM-DD. Leave empty for plans that do not require it.</p>
        </div>
      </div>

      <button type="button" onClick={runTest} disabled={running || !providerPackageId || !hasValidPlanId || (requiresTravelDate && !travelDate)}
        className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2">
        {running ? (
          <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Running...</>
        ) : !hasValidPlanId ? 'Missing Provider Plan ID' : (requiresTravelDate && !travelDate) ? 'Travel Date Required' : 'Run Test Purchase'}
      </button>

      {/* Result display */}
      {result && (
        <div className="mt-4 space-y-3">
          {/* Diagnostics */}
          {result.diagnostics && (
            <div className="rounded-lg border p-3 bg-gray-50">
              <p className="text-xs font-medium text-gray-500 mb-1">Diagnostics</p>
              <div className="text-[10px] text-gray-600 space-y-0.5">
                <div>Provider Plan ID: <code className="font-mono">{result.diagnostics.providerPlanId}</code></div>
                <div>Package: {result.diagnostics.providerPackageName}</div>
                <div>Quantity: {result.diagnostics.quantity}</div>
              </div>
            </div>
          )}

          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium text-gray-500 mb-2">Timeline</p>
            <div className="space-y-1.5">
              {(result.timeline || []).map((ev: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className={`w-1.5 h-1.5 mt-1 rounded-full shrink-0 ${
                    ev.eventType.includes('FAILED') || ev.eventType === 'PROVIDER_FAILED' ? 'bg-red-400' :
                    ev.eventType === 'FULFILLED' ? 'bg-emerald-400' : 'bg-gray-300'
                  }`} />
                  <div>
                    <span className="font-medium text-gray-700">{ev.eventType}</span>
                    {ev.message && <span className="text-gray-500 ml-1">— {ev.message}</span>}
                    <span className="text-gray-400 ml-1">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ESIM results */}
          {result.esims && result.esims.length > 0 && (
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium text-gray-500 mb-2">Mapped eSIMs</p>
              <div className="space-y-2">
                {result.esims.map((esim: any, i: number) => (
                  <div key={i} className="rounded bg-gray-50 p-2 text-xs space-y-0.5">
                    <div className="flex justify-between"><span className="text-gray-500">ICCID</span><code className="font-mono text-gray-900">{esim.iccid || <span className="text-red-400">MISSING</span>}</code></div>
                    {esim.imsi && <div className="flex justify-between"><span className="text-gray-500">IMSI</span><code className="font-mono text-gray-900">{esim.imsi}</code></div>}
                    {esim.activationCode && <div className="flex justify-between"><span className="text-gray-500">Activation Code</span><code className="font-mono text-gray-900 text-[10px]">{esim.activationCode}</code></div>}
                    {esim.qrCodeUrl && <div className="flex justify-between"><span className="text-gray-500">QR URL</span><code className="font-mono text-gray-900 text-[10px] break-all max-w-[200px]">{esim.qrCodeUrl}</code></div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Provider response raw */}
          {result.providerResponse && (
            <details className="rounded-lg border p-3">
              <summary className="text-xs font-medium text-gray-500 cursor-pointer">Provider Response (raw)</summary>
              <pre className="mt-2 text-[10px] font-mono text-gray-600 bg-gray-50 p-2 rounded overflow-x-auto max-h-48">
                {JSON.stringify(result.providerResponse, null, 2)}
              </pre>
            </details>
          )}

          {/* Error detail */}
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
              <p className="font-medium">Error at step: {result?.errorStep || 'unknown'}</p>
              <p>{error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
