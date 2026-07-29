'use client'

import { useState, useEffect, useCallback } from 'react'

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
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-cyan-50 px-2.5 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-100 transition-colors"
        aria-label="View QR code"
      >
        View QR
      </button>
      {open && <QrCodeModal esim={esim} onClose={() => setOpen(false)} />}
    </>
  )
}

function QrCodeModal({ esim, onClose }: { esim: QREsimProps; onClose: () => void }) {
  const [imgLoading, setImgLoading] = useState(!!esim.qrCodeUrl)
  const [imgError, setImgError] = useState(false)

  const lpaValue = resolveLPA(esim.providerResponse)
  const smdpAddress = extractSMDP(esim.providerResponse, lpaValue)
  const displayActivationCode = esim.activationCode || extractActivationCode(lpaValue)

  const handleEsc = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [handleEsc])

  const copyText = async (text: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for older browsers / non-HTTPS
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
    } catch { /* ignore clipboard errors */ }
  }

  const downloadQR = async () => {
    if (!esim.qrCodeUrl) return
    try {
      const res = await fetch(esim.qrCodeUrl)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `esim-${esim.iccid.slice(-6)}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      // Fallback: direct link
      const a = document.createElement('a')
      a.href = esim.qrCodeUrl
      a.target = '_blank'
      a.rel = 'noopener'
      a.download = `esim-${esim.iccid.slice(-6)}.png`
      a.click()
    }
  }

  const printQR = () => {
    if (!esim.qrCodeUrl) return
    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      // Popup blocked — open in current tab as fallback
      window.location.href = esim.qrCodeUrl
      return
    }
    printWindow.document.write(`<html><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh"><img src="${esim.qrCodeUrl}" style="max-width:90%" onload="setTimeout(()=>window.print(),500)" /></body></html>`)
    printWindow.document.close()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="eSIM QR Code"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border max-h-[90vh] overflow-y-auto mx-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold text-gray-900">eSIM QR Code</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            aria-label="Close dialog"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {esim.status !== 'ACTIVE' && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
              Status: {esim.status} — QR may not be ready
            </div>
          )}

          {esim.qrCodeUrl ? (
            <div className="flex justify-center">
              {imgLoading && !imgError && (
                <div className="w-48 h-48 rounded-lg border bg-gray-50 flex items-center justify-center">
                  <svg className="animate-spin w-6 h-6 text-gray-300" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                </div>
              )}
              <img
                src={esim.qrCodeUrl}
                alt="eSIM QR Code"
                className={`w-48 h-48 rounded-lg border ${imgLoading && !imgError ? 'hidden' : ''}`}
                onLoad={() => setImgLoading(false)}
                onError={() => { setImgLoading(false); setImgError(true) }}
              />
              {imgError && (
                <div className="w-48 h-48 rounded-lg border bg-red-50 flex items-center justify-center">
                  <p className="text-xs text-red-500 text-center px-2">QR image failed to load</p>
                </div>
              )}
            </div>
          ) : displayActivationCode ? (
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-sm text-gray-500">QR code available via LPA</p>
              <p className="text-xs text-gray-400 mt-1 font-mono truncate">{lpaValue?.slice(0, 60)}...</p>
            </div>
          ) : (
            <div className="rounded-lg bg-gray-50 p-4 text-center text-sm text-gray-400">
              {esim.status === 'PENDING_ACTIVATION' ? 'QR available after activation' : 'No QR code available'}
            </div>
          )}

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

          <div className="rounded-lg bg-cyan-50 border border-cyan-100 p-3">
            <p className="text-xs font-medium text-cyan-700 mb-1">Installation</p>
            <ol className="text-xs text-cyan-600 space-y-0.5 list-decimal list-inside">
              <li>Open Settings → Cellular / Mobile Data</li>
              <li>Tap &quot;Add eSIM&quot; or &quot;Add Cellular Plan&quot;</li>
              <li>Scan the QR code above</li>
              <li>Follow on-screen prompts to activate</li>
            </ol>
          </div>

          {esim.qrCodeUrl && !imgError && (
            <div className="flex gap-2">
              <button onClick={downloadQR} className="flex-1 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-700 transition-colors">
                Download QR (PNG)
              </button>
              <button onClick={printQR} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors">
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
        <span className="text-xs font-mono text-gray-700 truncate max-w-[180px]" title={value}>{value}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-cyan-600 hover:text-cyan-700"
          aria-label={`Copy ${label}`}
        >
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
