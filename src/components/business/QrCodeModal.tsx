'use client'

import { useState, useRef } from 'react'

interface QREsimProps {
  esimId: string
  iccid: string
  activationCode: string | null
  qrCodeUrl: string | null
  providerResponse: any
  status: string
  customerName: string | null
}

export function QrCodeButton({ esim }: { esim: QREsimProps }) {
  const [open, setOpen] = useState(false)

  const hasQR = !!(esim.qrCodeUrl || esim.activationCode)

  if (!hasQR) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-cyan-50 px-2.5 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-100 transition-colors"
      >
        View QR
      </button>

      {open && <QrCodeModal esim={esim} onClose={() => setOpen(false)} />}
    </>
  )
}

function QrCodeModal({ esim, onClose }: { esim: QREsimProps; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const lpaValue = resolveLPA(esim.providerResponse)
  const smdpAddress = extractSMDP(esim.providerResponse, lpaValue)
  const displayActivationCode = esim.activationCode || extractActivationCode(lpaValue)

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch { /* ignore */ }
  }

  const downloadQR = () => {
    if (!esim.qrCodeUrl) return
    const a = document.createElement('a')
    a.href = esim.qrCodeUrl
    a.download = `esim-${esim.iccid.slice(-6)}.png`
    a.click()
  }

  const printQR = () => {
    if (!esim.qrCodeUrl) return
    const w = window.open(esim.qrCodeUrl, '_blank')
    if (w) setTimeout(() => w.print(), 1000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">eSIM QR Code</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Status banner */}
          {esim.status !== 'ACTIVE' && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
              Status: {esim.status} — QR may not be ready
            </div>
          )}

          {/* QR Image */}
          {esim.qrCodeUrl ? (
            <div className="flex justify-center">
              <img
                src={esim.qrCodeUrl}
                alt="eSIM QR Code"
                className="w-48 h-48 rounded-lg border"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          ) : displayActivationCode ? (
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-sm text-gray-500">QR code sent via provider LPA</p>
              <p className="text-xs text-gray-400 mt-1 font-mono truncate">{lpaValue?.slice(0, 60)}...</p>
            </div>
          ) : (
            <div className="rounded-lg bg-gray-50 p-4 text-center text-sm text-gray-400">
              {esim.status === 'PENDING_ACTIVATION' ? 'QR code available after activation' : 'No QR code available'}
            </div>
          )}

          {/* Details */}
          <div className="space-y-3">
            <DetailRow label="ICCID" value={esim.iccid} onCopy={() => copyText(esim.iccid)} />
            {displayActivationCode && (
              <DetailRow label="Activation Code" value={displayActivationCode} onCopy={() => copyText(displayActivationCode)} />
            )}
            {smdpAddress && (
              <DetailRow label="SM-DP+ Address" value={smdpAddress} onCopy={() => copyText(smdpAddress)} />
            )}
            {esim.customerName && (
              <div className="flex justify-between items-center py-1">
                <span className="text-xs text-gray-500">Assigned to</span>
                <span className="text-xs font-medium text-gray-700">{esim.customerName}</span>
              </div>
            )}
          </div>

          {/* Installation instructions */}
          <div className="rounded-lg bg-cyan-50 border border-cyan-100 p-3">
            <p className="text-xs font-medium text-cyan-700 mb-1">Installation</p>
            <ol className="text-xs text-cyan-600 space-y-0.5 list-decimal list-inside">
              <li>Open Settings → Cellular / Mobile Data</li>
              <li>Tap "Add eSIM" or "Add Cellular Plan"</li>
              <li>Scan the QR code above</li>
              <li>Follow on-screen prompts to activate</li>
            </ol>
          </div>

          {/* Actions */}
          {esim.qrCodeUrl && (
            <div className="flex gap-2">
              <button onClick={downloadQR} className="flex-1 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-700">
                Download QR (PNG)
              </button>
              <button onClick={printQR} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
                Print
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex justify-between items-center py-1 border-b border-gray-50">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-gray-700 truncate max-w-[180px]">{value}</span>
        <button onClick={handleCopy} className="text-xs text-cyan-600 hover:text-cyan-700">
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

function resolveLPA(providerResponse: any): string | null {
  if (!providerResponse) return null
  try {
    const data = typeof providerResponse === 'string' ? JSON.parse(providerResponse) : providerResponse
    if (data?.lpa) return data.lpa
    if (data?.qrCodeValue) return data.qrCodeValue
    if (data?.activationData?.lpa) return data.activationData.lpa
    return null
  } catch { return null }
}

function extractSMDP(providerResponse: any, lpaValue: string | null): string | null {
  if (lpaValue && lpaValue.startsWith('LPA:')) {
    const parts = lpaValue.split('$')
    return parts[1] || null
  }
  if (!providerResponse) return null
  try {
    const data = typeof providerResponse === 'string' ? JSON.parse(providerResponse) : providerResponse
    return data?.smdpAddress || data?.smdp || data?.activationData?.smdpAddress || null
  } catch { return null }
}

function extractActivationCode(lpaValue: string | null): string | null {
  if (lpaValue && lpaValue.startsWith('LPA:')) {
    const parts = lpaValue.split('$')
    return parts[2] || null
  }
  return null
}

export type { QREsimProps }
