'use client'

import { useState, useRef } from 'react'
import type { ImportedPlanRow } from '@/lib/actions/imported-plans'

export function InlinePricingForm({ plan }: { plan: ImportedPlanRow }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function handleSave(formData: FormData) {
    setSaving(true); setMsg('')
    try {
      const { saveImportedPlanPricing } = await import('@/lib/actions/imported-plans')
      const res = await saveImportedPlanPricing(formData)
      if (res.success) { setMsg('Saved'); setEditing(false); window.location.reload() }
      else setMsg(res.error || 'Error')
    } catch (e: any) { setMsg(e.message || 'Error') }
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
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500">Cancel</button>
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
            className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">Edit</button>
        </div>
      )}
      {msg && <span className="text-xs text-emerald-600 ml-1">{msg}</span>}
    </form>
  )
}

function ActionButton({ onClick, label, color, disabled, small }: { onClick: () => void; label: string; color: string; disabled?: boolean; small?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`${small ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'} rounded ${color} disabled:opacity-50 disabled:cursor-not-allowed`}>
      {label}
    </button>
  )
}

export function PlanActions({ plan }: { plan: ImportedPlanRow }) {
  const [loading, setLoading] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  async function act(fn: string, param?: string) {
    setLoading(fn); setMsg('')
    try {
      const mod = await import('@/lib/actions/imported-plans')
      let res: any
      if (fn === 'publish') {
        const fd = new FormData(); fd.set('providerPackageId', plan.providerPackageId)
        res = await mod.publishImportedPlan(fd)
      } else if (fn === 'markReady') {
        res = await mod.markReadyToPublish(plan.providerPackageId)
      } else if (fn === 'unmarkReady') {
        res = await mod.unmarkReadyToPublish(plan.providerPackageId)
      } else if (fn === 'archive') {
        res = await mod.archiveImportedPlan(plan.providerPackageId)
      }
      if (res?.success) { setMsg('✓'); window.location.reload() }
      else setMsg(res?.error || 'Error')
    } catch (e: any) { setMsg(e.message || 'Error') }
    setLoading(null)
  }

  if (plan.status === 'archived') return <span className="text-xs text-gray-400">Archived</span>
  if (plan.status === 'published') return <span className="text-xs text-emerald-600">Published</span>

  const canPublish = plan.costPriceUSD != null && plan.costPriceUSD > 0 && plan.sellingPrice != null && plan.sellingPrice > 0
  const isReady = plan.readyToPublish

  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      {isReady ? (
        <ActionButton onClick={() => act('unmarkReady')} label="Unmark Ready" color="border border-gray-300 text-gray-600 hover:bg-gray-50" small />
      ) : (
        <ActionButton onClick={() => act('markReady')} label="Mark Ready" color="bg-purple-600 text-white hover:bg-purple-700 shadow-sm" small disabled={!canPublish} />
      )}
      <ActionButton onClick={() => act('publish')} label="Publish" color="bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm" small disabled={!canPublish || !isReady} />
      <ActionButton onClick={() => act('archive')} label="Archive" color="border border-red-200 text-red-500 hover:bg-red-50" small />
      {loading && <span className="text-xs text-gray-400">...</span>}
      {msg && <span className={`text-xs ${msg.includes('✓') ? 'text-emerald-600' : 'text-red-500'}`}>{msg}</span>}
    </div>
  )
}

export default function ImportedPlansActions({ plan }: { plan: ImportedPlanRow }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <InlinePricingForm plan={plan} />
      <PlanActions plan={plan} />
    </div>
  )
}
