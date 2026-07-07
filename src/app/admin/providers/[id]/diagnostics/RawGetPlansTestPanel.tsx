'use client'

import { useState } from 'react'
import { rawGetPlansTest } from '@/lib/actions/provider-diagnostics-raw'

const PRESETS: { label: string; body: any }[] = [
  { label: 'A: UK + countryCode', body: { flag: 6, countryCode: 'UK', multiplecountrycode: ['UK'] } },
  { label: 'B: string + UK', body: { flag: 6, countryCode: 'string', multiplecountrycode: ['UK'] } },
  { label: 'C: empty countryCode', body: { flag: 6, countryCode: '', multiplecountrycode: ['UK'] } },
  { label: 'D: no countryCode', body: { flag: 6, multiplecountrycode: ['UK'] } },
  { label: 'E: empty array', body: { flag: 6, countryCode: 'UK', multiplecountrycode: [] } },
]

export function RawGetPlansTestPanel({ providerId }: { providerId: string }) {
  const [bodyText, setBodyText] = useState(JSON.stringify(PRESETS[0].body, null, 2))
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  async function handleSend() {
    setLoading(true)
    setResult(null)
    try {
      const res = await rawGetPlansTest(providerId, bodyText)
      setResult(res)
    } catch (e: any) {
      setResult({ success: false, error: e.message || 'Request failed' })
    } finally {
      setLoading(false)
    }
  }

  function applyPreset(body: any) {
    setBodyText(JSON.stringify(body, null, 2))
    setResult(null)
  }

  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Raw GET_PLANS Test</h3>
          <p className="text-xs text-gray-500">Send custom request bodies to debug AirHub GetPlanInformation. No data is imported.</p>
        </div>
      </div>

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(p => (
          <button key={p.label} type="button" onClick={() => applyPreset(p.body)}
            className="rounded border border-gray-200 px-2 py-1 text-[10px] font-medium text-gray-600 hover:bg-gray-100">
            {p.label}
          </button>
        ))}
      </div>

      {/* Body editor */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Request Body (JSON)</label>
        <textarea value={bodyText} onChange={e => { setBodyText(e.target.value); setResult(null) }}
          rows={8} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs font-mono focus:border-cyan-500 focus:outline-none" />
      </div>

      <button type="button" onClick={handleSend} disabled={loading}
        className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
        {loading ? 'Sending...' : 'Send GET_PLANS Request'}
      </button>

      {/* Response */}
      {result && (
        <div className="space-y-2">
          {result.error ? (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
              <p className="font-medium">Error</p>
              <p>{result.error}</p>
            </div>
          ) : (
            <>
              <div className="flex gap-3 text-xs">
                <span className="font-medium text-gray-500">HTTP Status:</span>
                <span className={result.status === 200 ? 'text-emerald-600' : 'text-red-600'}>{result.status}</span>
                {result.responseKeys && (
                  <>
                    <span className="font-medium text-gray-500">Keys:</span>
                    <span className="font-mono text-gray-700">{result.responseKeys.join(', ') || '—'}</span>
                  </>
                )}
              </div>
              <details className="rounded-lg border p-3">
                <summary className="text-xs font-medium text-gray-500 cursor-pointer">Request Body</summary>
                <pre className="mt-2 text-[11px] font-mono text-gray-600 whitespace-pre-wrap">{result.requestBody}</pre>
              </details>
              <details className="rounded-lg border p-3" open>
                <summary className="text-xs font-medium text-gray-500 cursor-pointer">Response</summary>
                <pre className="mt-2 text-[11px] font-mono text-gray-600 overflow-x-auto max-h-96">{JSON.stringify(result.responseBody, null, 2)}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  )
}
