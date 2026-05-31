'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface ShareActionsProps {
  esimId: string
  iccid: string
  activationCode?: string | null
  qrCodeUrl?: string | null
  packageName: string
  whatsAppUrl: string
  customerEmail?: string | null
}

export default function ShareActions({ esimId, iccid, activationCode, qrCodeUrl, packageName, whatsAppUrl, customerEmail }: ShareActionsProps) {
  const [open, setOpen] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [emailInput, setEmailInput] = useState(customerEmail || '')
  const router = useRouter()

  const copyActivationCode = async () => {
    if (activationCode) {
      await navigator.clipboard.writeText(activationCode)
      alert('Activation code copied!')
    }
  }

  const copyIccid = async () => {
    await navigator.clipboard.writeText(iccid)
    alert('ICCID copied!')
  }

  const copyInstallLink = async () => {
    try {
      const res = await fetch('/api/v1/esims/' + esimId + '/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (data.success && data.installLink) {
        await navigator.clipboard.writeText(data.installLink)
        alert('Install link copied!')
      } else {
        alert('Failed to generate link')
      }
    } catch {
      alert('Failed to generate link')
    }
  }

  const shareViaEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!emailInput) return

    setEmailSending(true)
    try {
      const res = await fetch('/api/v1/esims/' + esimId + '/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput }),
      })
      const data = await res.json()
      if (data.success) {
        alert('eSIM shared via email!')
        setOpen(false)
        router.refresh()
      } else {
        alert('Failed to send email')
      }
    } catch {
      alert('Failed to send email')
    } finally {
      setEmailSending(false)
    }
  }

  const handleShareViaWhatsApp = () => {
    window.open(whatsAppUrl, '_blank')
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-xs font-medium text-purple-600 hover:text-purple-700"
      >
        Share
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white shadow-lg">
            <div className="p-2 space-y-1">
              <p className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">Share via</p>

              <button onClick={handleShareViaWhatsApp} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-emerald-50">
                <span className="text-emerald-500">💬</span> WhatsApp
              </button>

              <form onSubmit={shareViaEmail} className="px-2 py-1.5">
                <p className="text-xs text-gray-700 mb-1">📧 Email</p>
                <div className="flex gap-1">
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="recipient@email.com"
                    required
                    className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-1 text-xs focus:border-emerald-400 focus:outline-none"
                  />
                  <button type="submit" disabled={emailSending} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    {emailSending ? '...' : 'Send'}
                  </button>
                </div>
              </form>

              <div className="border-t border-gray-100 my-1" />

              <p className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">Copy</p>

              <button onClick={copyIccid} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                <span>📋</span> Copy ICCID
              </button>

              {activationCode && (
                <button onClick={copyActivationCode} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  <span>🔑</span> Copy Activation Code
                </button>
              )}

              <button onClick={copyInstallLink} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                <span>🔗</span> Copy Install Link
              </button>

              {qrCodeUrl && (
                <a href={qrCodeUrl} target="_blank" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  <span>📲</span> View QR Code
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}