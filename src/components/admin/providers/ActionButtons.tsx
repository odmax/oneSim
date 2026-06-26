'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function ProviderActionButton({ label, loadingLabel, onClick, color = 'cyan' }: {
  label: string; loadingLabel: string; onClick: () => Promise<string | null>; color?: string
}) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const colors: Record<string, string> = {
    cyan: 'border-cyan-300 text-cyan-700 hover:bg-cyan-50',
    emerald: 'bg-emerald-600 text-white hover:bg-emerald-700',
    amber: 'bg-amber-600 text-white hover:bg-amber-700',
  }

  return (
    <button type="button" onClick={async () => {
      setLoading(true)
      try {
        const error = await onClick()
        if (error) { alert(error); setLoading(false) }
        else router.refresh()
      } catch { setLoading(false) }
    }} disabled={loading}
      className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${colors[color] || colors.cyan}`}>
      {loading && <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
      {loading ? loadingLabel : label}
    </button>
  )
}

export function ActionForm({ action, label, loadingLabel, color = 'cyan' }: {
  action: (formData: FormData) => Promise<any>
  label: string; loadingLabel: string; color?: string
}) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const colors: Record<string, string> = {
    cyan: 'border-cyan-300 text-cyan-700 hover:bg-cyan-50',
    emerald: 'bg-emerald-600 text-white hover:bg-emerald-700',
    amber: 'bg-amber-600 text-white hover:bg-amber-700',
    blue: 'bg-blue-600 text-white hover:bg-blue-700',
  }

  return (
    <form action={async (fd) => {
      setLoading(true)
      try { await action(fd); router.refresh() }
      catch { setLoading(false) }
    }}>
      <button type="submit" disabled={loading}
        className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${colors[color] || colors.cyan}`}>
        {loading && <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
        {loading ? loadingLabel : label}
      </button>
    </form>
  )
}
