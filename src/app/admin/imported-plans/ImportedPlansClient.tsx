'use client'

import { useState } from 'react'
import type { ImportedPlanRow } from '@/lib/actions/imported-plans'

function CostSourceBadge({ source }: { source: string | null }) {
  if (source === 'ADMIN_OVERRIDE') return <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">Admin Override</span>
  if (source === 'PROVIDER') return <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-600">Provider</span>
  return <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">Missing Cost</span>
}

export function InlinePricingForm({ plan }: { plan: ImportedPlanRow }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [adminCostInput, setAdminCostInput] = useState(plan.adminCostPrice != null ? String(plan.adminCostPrice) : '')

  const providerCost = plan.providerCostPrice
  const effCost = plan.effectiveCostPrice
  const costMissing = effCost == null || effCost <= 0
  const sellMissing = plan.sellingPrice == null || plan.sellingPrice <= 0

  async function handleSave(formData: FormData) {
    setSaving(true); setMsg('')
    try {
      const { saveImportedPlanPricing } = await import('@/lib/actions/imported-plans')
      const res = await saveImportedPlanPricing(formData)
      if (res.success) {
        setMsg('✓ Cost updated + cheapest recalculated')
        setEditing(false)
        setTimeout(() => window.location.reload(), 800)
      } else setMsg(res.error || 'Error')
    } catch (e: any) { setMsg(e.message || 'Error') }
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {/* Provider cost display */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-400">Provider:</span>
        <span className="font-mono text-gray-500">
          {providerCost > 0 ? `$${providerCost.toFixed(2)}` : providerCost === 0 ? '$0.00' : '—'}
        </span>
      </div>

      {/* Admin cost input — always visible for quick editing */}
      <form action={handleSave} className="space-y-1">
        <input type="hidden" name="providerPackageId" value={plan.providerPackageId} />

        <div className="flex items-center gap-1">
          <span className="text-[11px] text-gray-400 shrink-0">Admin:</span>
          <input name="adminCostPrice" type="number" step="0.01" min="0"
            value={adminCostInput}
            onChange={e => setAdminCostInput(e.target.value)}
            placeholder="0.00"
            className={`w-full rounded border px-2 py-1 text-xs font-mono
              ${costMissing ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}
              focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500`}
          />
        </div>

        {/* Effective cost + source */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-gray-400">Effective:</span>
          {effCost != null && effCost > 0 ? (
            <span className="font-semibold text-gray-900">${effCost.toFixed(2)}</span>
          ) : (
            <span className="text-amber-600 font-medium">Missing Cost</span>
          )}
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-gray-400">Source:</span>
          <CostSourceBadge source={plan.costSource} />
        </div>

        {/* Selling price input (collapsible) */}
        {editing && (
          <div className="pt-1 space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-gray-400 shrink-0">Sell:</span>
              <input name="sellingPrice" type="number" step="0.01" min="0" defaultValue={plan.sellingPrice || ''}
                placeholder="0.00"
                className="w-full rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </div>
            {sellMissing && effCost != null && effCost > 0 && (
              <p className="text-[10px] text-gray-400">
                Suggested: <strong>${(effCost * 1.3).toFixed(2)}</strong> (30% markup)
              </p>
            )}
            <div className="flex gap-1 pt-1">
              <button type="submit" disabled={saving}
                className="flex-1 rounded bg-emerald-600 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button type="button" onClick={() => setEditing(false)}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500">Cancel</button>
            </div>
          </div>
        )}

        {!editing && (
          <button type="button" onClick={() => setEditing(true)}
            className="w-full rounded border border-gray-200 py-1 text-xs text-gray-600 hover:bg-gray-50 mt-1">
            {sellMissing ? 'Set Selling Price' : 'Edit Prices'}
          </button>
        )}
      </form>

      {msg && (
        <div className={`text-[10px] text-center font-medium ${msg.startsWith('✓') ? 'text-emerald-600' : 'text-red-500'}`}>
          {msg}
        </div>
      )}
    </div>
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
      } else if (fn === 'markReady') res = await mod.markReadyToPublish(plan.providerPackageId)
      else if (fn === 'unmarkReady') res = await mod.unmarkReadyToPublish(plan.providerPackageId)
      else if (fn === 'archive') res = await mod.archiveImportedPlan(plan.providerPackageId)
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
    <div className="flex flex-col items-center gap-2 w-44">
      <InlinePricingForm plan={plan} />
      <PlanActions plan={plan} />
    </div>
  )
}
