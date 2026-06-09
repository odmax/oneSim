'use client'

import { useState } from 'react'

export default function InstallClient({ esim, token }: { esim: any; token: string }) {
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState(esim)
  const [error, setError] = useState<string | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch { /* clipboard not available */ }
  }

  async function refreshStatus() {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`/api/install/${token}/refresh-status`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setStatus({ ...status, status: data.newStatus || status.status, activationDetectedAt: data.activationDetectedAt || status.activationDetectedAt, dataUsedMB: data.dataUsedMB ?? status.dataUsedMB })
      } else {
        setError(data.error?.message || 'Refresh failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setRefreshing(false)
    }
  }

  const remaining = status.dataRemainingMB ?? (status.dataTotalMB - status.dataUsedMB)
  const usagePct = status.dataTotalMB > 0 ? Math.round((status.dataUsedMB / status.dataTotalMB) * 100) : 0

  const StatusBadge = ({ s }: { s: string }) => {
    const colors: Record<string, string> = {
      ACTIVE: 'bg-emerald-100 text-emerald-700',
      PENDING_ACTIVATION: 'bg-amber-100 text-amber-700',
      PENDING: 'bg-amber-100 text-amber-700',
      EXPIRED: 'bg-red-100 text-red-700',
      SUSPENDED: 'bg-orange-100 text-orange-700',
      FAILED: 'bg-red-100 text-red-700',
    }
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${colors[s] || 'bg-gray-100 text-gray-700'}`}>
        <span className={`h-2 w-2 rounded-full ${s === 'ACTIVE' ? 'bg-emerald-400' : s === 'PENDING_ACTIVATION' || s === 'PENDING' ? 'bg-amber-400' : 'bg-red-400'}`} />
        {status.statusLabel || s}
      </span>
    )
  }

  // Step-by-step install instructions
  const steps = [
    { platform: 'iPhone / iOS', icon: '📱', steps: ['Go to Settings → Cellular → Add eSIM', 'Scan the QR code below', 'Follow on-screen instructions'] },
    { platform: 'Android', icon: '🤖', steps: ['Go to Settings → Network → Mobile Network → Add Carrier', 'Scan the QR code below', 'Follow on-screen instructions'] },
    { platform: 'Manual Activation', icon: '⚙️', steps: ['Select "Enter details manually" when prompted', `Enter SM-DP+ address if required`, `Enter Activation Code: ${status.activationCode || 'N/A'}`] },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="text-3xl font-bold text-emerald-600">OneSim</div>
          <h1 className="text-xl font-semibold text-gray-900">Install Your eSIM</h1>
          <StatusBadge s={status.status} />
        </div>

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {/* QR Code */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm text-center space-y-3">
          {status.qrCodeUrl ? (
            <>
              <img src={status.qrCodeUrl} alt="eSIM QR Code" className="mx-auto w-48 h-48 rounded-xl border-2 border-gray-200" />
              <p className="text-xs text-gray-400">Scan this QR code with your phone camera to install</p>
            </>
          ) : (
            <div className="w-48 h-48 mx-auto rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center">
              <p className="text-sm text-gray-400">QR code not yet available</p>
            </div>
          )}
        </div>

        {/* Activation Code */}
        {status.activationCode && (
          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Activation Code</p>
            <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
              <code className="text-lg font-mono font-bold text-gray-900 tracking-wider">{status.activationCode}</code>
              <button onClick={() => copyToClipboard(status.activationCode, 'activation')} className="ml-3 shrink-0 rounded-lg bg-emerald-100 px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-200">
                {copiedField === 'activation' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Install Instructions */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Installation Instructions</h2>
          {steps.map(s => (
            <details key={s.platform} className="bg-white rounded-xl border border-gray-100 shadow-sm">
              <summary className="px-5 py-4 cursor-pointer flex items-center gap-3 text-sm font-medium text-gray-900">
                <span className="text-xl">{s.icon}</span>
                {s.platform}
              </summary>
              <div className="px-5 pb-4 space-y-2">
                {s.steps.map((step, i) => (
                  <div key={i} className="flex gap-3 text-sm text-gray-600">
                    <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">{i + 1}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>

        {/* eSIM Details */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">eSIM Details</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center py-1.5">
              <span className="text-gray-500">Package</span>
              <span className="font-medium text-gray-900">{status.packageName}</span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-gray-500">ICCID</span>
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs text-gray-900">{status.iccid}</code>
                <button onClick={() => copyToClipboard(status.iccid, 'iccid')} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">
                  {copiedField === 'iccid' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            {status.imsi && <div className="flex justify-between py-1.5"><span className="text-gray-500">IMSI</span><code className="font-mono text-xs text-gray-900">{status.imsi}</code></div>}
            {status.expiresAt && <div className="flex justify-between py-1.5"><span className="text-gray-500">Expires</span><span className="text-gray-900">{new Date(status.expiresAt).toLocaleDateString()}</span></div>}
          </div>
        </div>

        {/* Data Usage */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Data Usage</h2>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-gray-500">{((status.dataUsedMB || 0) / 1024).toFixed(2)} GB used</span>
            <span className="text-sm text-gray-500">{Math.max(0, remaining / 1024).toFixed(2)} GB remaining</span>
          </div>
          <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${usagePct > 80 ? 'bg-red-400' : usagePct > 50 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.min(usagePct, 100)}%` }} />
          </div>
          {status.lastUsageAt && <p className="text-xs text-gray-400">Last usage: {new Date(status.lastUsageAt).toLocaleDateString()}</p>}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button onClick={refreshStatus} disabled={refreshing} className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm">
            {refreshing ? 'Refreshing...' : 'Refresh Status'}
          </button>
        </div>

        {/* Support */}
        <div className="text-center py-4">
          <p className="text-sm text-gray-500">Need help? Contact the business that provided this eSIM.</p>
        </div>

        {/* Troubleshooting */}
        <details className="bg-white rounded-xl border border-gray-100 shadow-sm">
          <summary className="px-5 py-4 cursor-pointer text-sm font-medium text-gray-900">Troubleshooting</summary>
          <div className="px-5 pb-4 space-y-3 text-sm text-gray-600">
            <p><strong>QR code won't scan?</strong> Make sure your device supports eSIM and your camera is focused on the QR code. Try increasing screen brightness.</p>
            <p><strong>Activation code not working?</strong> Double-check the code. Try copying it instead of typing manually.</p>
            <p><strong>No network after installation?</strong> Restart your device. Go to Settings → Cellular and make sure the eSIM line is turned on with data roaming enabled if needed.</p>
            <p><strong>eSIM not showing up?</strong> Remove the eSIM profile and scan the QR code again. If the problem persists, contact support.</p>
          </div>
        </details>
      </div>
    </div>
  )
}