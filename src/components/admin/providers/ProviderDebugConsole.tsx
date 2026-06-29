'use client'

import { useState } from 'react'

interface DebugLog {
  id: string
  operation: string
  url: string
  method: string
  requestHeaders?: Record<string, string>
  requestBody?: any
  responseStatus?: number
  responseBody?: any
  durationMs?: number
  timestamp: string
  error?: string
  mappedFields?: {
    iccid?: string | null
    activationCode?: string | null
    qrCodeUrl?: string | null
    providerOrderId?: string | null
    smdpAddress?: string | null
    mappingErrors?: string[]
  }
}

export function ProviderDebugConsole({ logs }: { logs: DebugLog[] }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (logs.length === 0) return null

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Debug Console</span>
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{logs.length}</span>
        </div>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {logs.map(log => (
            <div key={log.id}>
              <button type="button" onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                className="flex w-full items-center justify-between px-5 py-2.5 text-sm hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    log.error ? 'bg-red-100 text-red-700' : log.responseStatus && log.responseStatus >= 200 && log.responseStatus < 300
                      ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {log.responseStatus || log.error ? (log.error ? 'ERR' : log.responseStatus) : '...'}
                  </span>
                  <span className="font-mono text-[11px] text-gray-500 w-12">{log.method}</span>
                  <span className="text-gray-700 font-medium">{log.operation}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  {log.durationMs != null && <span>{log.durationMs}ms</span>}
                  {log.mappedFields?.iccid && <span className="text-emerald-600 font-medium">ICCID ✓</span>}
                  {log.mappedFields?.mappingErrors && log.mappedFields.mappingErrors.length > 0 && (
                    <span className="text-red-500 font-medium">!Map</span>
                  )}
                  <svg className={`w-3 h-3 transition-transform ${expanded === log.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {expanded === log.id && (
                <div className="px-5 pb-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-gray-400">URL:</span> <code className="text-gray-700 font-mono break-all">{log.url}</code></div>
                    <div><span className="text-gray-400">Time:</span> <span className="text-gray-700">{new Date(log.timestamp).toLocaleString()}</span></div>
                  </div>

                  {log.requestHeaders && Object.keys(log.requestHeaders).length > 0 && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">Request Headers</p>
                      <pre className="rounded bg-gray-50 p-2 text-[10px] font-mono text-gray-600 overflow-x-auto">
                        {Object.entries(log.requestHeaders).map(([k, v]) => {
                          const masked = k.toLowerCase().includes('auth') || k.toLowerCase().includes('key') || k.toLowerCase().includes('secret')
                            ? v.slice(0, 4) + '••••' + v.slice(-4)
                            : v
                          return `${k}: ${masked}`
                        }).join('\n')}
                      </pre>
                    </div>
                  )}

                  {log.requestBody && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">Request Body</p>
                      <pre className="rounded bg-gray-50 p-2 text-[10px] font-mono text-gray-600 overflow-x-auto max-h-32">
                        {maskSecrets(JSON.stringify(log.requestBody, null, 2))}
                      </pre>
                    </div>
                  )}

                  {log.error && (
                    <div>
                      <p className="text-[10px] font-medium text-red-400 uppercase mb-1">Error</p>
                      <pre className="rounded bg-red-50 p-2 text-[10px] font-mono text-red-600 overflow-x-auto">{log.error}</pre>
                    </div>
                  )}

                  {log.responseBody && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">Response</p>
                      <pre className="rounded bg-gray-50 p-2 text-[10px] font-mono text-gray-600 overflow-x-auto max-h-48">
                        {typeof log.responseBody === 'string' ? log.responseBody : maskSecrets(JSON.stringify(log.responseBody, null, 2))}
                      </pre>
                    </div>
                  )}

                  {/* Mapped fields section */}
                  {log.mappedFields && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">Mapped Fields</p>
                      <div className="rounded bg-indigo-50 p-2 space-y-1">
                        {log.mappedFields.iccid != null && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-medium">ICCID</span>
                            <code className="font-mono text-indigo-700">{log.mappedFields.iccid}</code>
                          </div>
                        )}
                        {log.mappedFields.activationCode != null && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-medium">Activation Code</span>
                            <code className="font-mono text-indigo-700">{log.mappedFields.activationCode}</code>
                          </div>
                        )}
                        {log.mappedFields.qrCodeUrl != null && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-medium">QR Code URL</span>
                            <code className="font-mono text-indigo-700 text-[9px] break-all max-w-[200px]">{log.mappedFields.qrCodeUrl}</code>
                          </div>
                        )}
                        {log.mappedFields.providerOrderId != null && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-medium">Provider Order ID</span>
                            <code className="font-mono text-indigo-700">{log.mappedFields.providerOrderId}</code>
                          </div>
                        )}
                        {log.mappedFields.smdpAddress != null && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-medium">SMDP Address</span>
                            <code className="font-mono text-indigo-700">{log.mappedFields.smdpAddress}</code>
                          </div>
                        )}
                        {log.mappedFields.mappingErrors && log.mappedFields.mappingErrors.length > 0 && (
                          <div className="mt-1 pt-1 border-t border-indigo-200">
                            <p className="text-[10px] font-medium text-red-500 mb-0.5">Mapping Errors</p>
                            {log.mappedFields.mappingErrors.map((err, i) => (
                              <p key={i} className="text-[10px] text-red-600">• {err}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function maskSecrets(json: string): string {
  return json
    .replace(/"password"\s*:\s*"[^"]+"/g, '"password": "••••••••"')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token": "••••••••"')
    .replace(/"apiKey"\s*:\s*"[^"]+"/g, '"apiKey": "••••••••"')
    .replace(/"apiToken"\s*:\s*"[^"]+"/g, '"apiToken": "••••••••"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "••••••••"')
}
