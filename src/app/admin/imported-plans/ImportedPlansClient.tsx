'use client'

import { useState, useRef } from 'react'
import type { ImportedPlanRow } from '@/lib/actions/imported-plans'

export function InlinePricingForm({ plan }: { plan: ImportedPlanRow }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSave(formData: FormData) {
    setSaving(true)
    setMessage('')
    try {
      const { saveImportedPlanPricing } = await import('@/lib/actions/imported-plans')
      const res = await saveImportedPlanPricing(formData)
      if (res.success) { setMessage('Saved'); setEditing(false) }
      else setMessage(res.error || 'Error')
    } catch (e: any) {
      setMessage(e.message || 'Error')
    }
    setSaving(false)
  }

  const costMissing = plan.costPriceUSD == null || plan.costPriceUSD <= 0
  const priceMissing = plan.sellingPrice == null || plan.sellingPrice <= 0

  return (
    <form action={handleSave} className="flex items-center gap-1">
      <input type="hidden" name="providerPackageId" value={plan.providerPackageId} />
      {editing ? (
        <>
          <input name="costPriceUSD" type="number" step="0.01" min="0" defaultValue={plan.costPriceUSD || ''}
            placeholder="Cost" className="w-20 rounded border border-gray-200 px-2 py-1 text-xs" />
          <input name="sellingPrice" type="number" step="0.01" min="0" defaultValue={plan.sellingPrice || ''}
            placeholder="Sell" className="w-20 rounded border border-gray-200 px-2 py-1 text-xs" />
          <button type="submit" disabled={saving}
            className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
            {saving ? '...' : 'Save'}
          </button>
          <button type="button" onClick={() => setEditing(false)}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500">
            Cancel
          </button>
        </>
      ) : (
        <div className="flex gap-1">
          {(costMissing || priceMissing) && (
            <button type="button" onClick={() => setEditing(true)}
              className="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700 shadow-sm">
              Set {costMissing && priceMissing ? 'Prices' : costMissing ? 'Cost' : 'Price'}
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)}
            className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
            Edit
          </button>
        </div>
      )}
      {message && <span className="text-xs text-emerald-600 ml-1">{message}</span>}
    </form>
  )
}

export function PublishButton({ plan }: { plan: ImportedPlanRow }) {
  const [publishing, setPublishing] = useState(false)
  const [msg, setMsg] = useState('')

  async function handlePublish() {
    setPublishing(true)
    setMsg('')
    try {
      const { publishImportedPlan } = await import('@/lib/actions/imported-plans')
      const fd = new FormData()
      fd.set('providerPackageId', plan.providerPackageId)
      const res = await publishImportedPlan(fd)
      if (res.success) {
        setMsg('Published!')
        window.location.reload()
      } else {
        setMsg(res.error || 'Error')
      }
    } catch (e: any) {
      setMsg(e.message || 'Error')
    }
    setPublishing(false)
  }

  const canPublish = plan.costPriceUSD != null && plan.costPriceUSD > 0 && plan.sellingPrice != null && plan.sellingPrice > 0

  if (plan.status === 'published') return null

  if (plan.status === 'archived') return <span className="text-xs text-gray-400">Archived</span>

  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={handlePublish} disabled={publishing || !canPublish}
        className="rounded bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
        {publishing ? '...' : 'Publish'}
      </button>
      {msg && <span className={`text-xs ${msg.includes('!') ? 'text-emerald-600' : 'text-red-500'}`}>{msg}</span>}
    </div>
  )
}

export default function ImportedPlansActions({ plan }: { plan: ImportedPlanRow }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <InlinePricingForm plan={plan} />
      <PublishButton plan={plan} />
    </div>
  )
}
