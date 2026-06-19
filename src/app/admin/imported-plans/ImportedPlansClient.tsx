'use client'

import { useState } from 'react'
import type { ImportedPlanRow } from '@/lib/actions/imported-plans'

export function InlinePricingForm({ plan }: { plan: ImportedPlanRow }) {
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [costInput, setCostInput] = useState(plan.adminCostPrice != null ? String(plan.adminCostPrice) : '')
  const [sellInput, setSellInput] = useState(plan.sellingPrice != null ? String(plan.sellingPrice) : '')

  const providerCost = plan.providerCostPrice
  const effCost = plan.effectiveCostPrice
  const hasProviderCost = providerCost > 0
  const canReady = (effCost != null && effCost > 0) || (parseFloat(costInput) > 0)

  async function handleSave(formData: FormData) {
    setSaving(true); setMsg('')
    try {
      const { saveImportedPlanPricing } = await import('@/lib/actions/imported-plans')
      const res = await saveImportedPlanPricing(formData)
      if (res.success) {
        setMsg('Pricing saved ✓')
        setTimeout(() => window.location.reload(), 600)
      } else setMsg(res.error || 'Failed to save')
    } catch (e: any) { setMsg(e.message || 'Error') }
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-2 w-48">
      <form action={handleSave} className="space-y-1.5">
        <input type="hidden" name="providerPackageId" value={plan.providerPackageId} />

        {/* Provider Cost (read-only) */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">Provider Cost</span>
          <span className="font-mono text-gray-500">
            {hasProviderCost ? `$${providerCost.toFixed(2)}` : providerCost === 0 ? '$0.00' : '—'}
          </span>
        </div>

        {/* Cost Price */}
        <div>
          <input name="adminCostPrice" type="text" inputMode="decimal"
            value={costInput}
            onChange={e => setCostInput(e.target.value)}
            placeholder={hasProviderCost ? 'Override cost' : 'Cost price *'}
            className={`w-full rounded border px-2.5 py-1.5 text-sm font-mono
              ${!canReady ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}
              focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500`}
          />
        </div>

        {/* Sell Price */}
        <div>
          <input name="sellingPrice" type="text" inputMode="decimal"
            value={sellInput}
            onChange={e => setSellInput(e.target.value)}
            placeholder="Sell price *"
            className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-sm font-mono focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        {/* Validation warning */}
        {(!costInput || parseFloat(costInput.replace(',', '.')) <= 0 || !sellInput || parseFloat(sellInput.replace(',', '.')) <= 0) && (
          <p className="text-[10px] text-amber-600">Set cost and sell price first.</p>
        )}

        {/* Primary save button */}
        <button type="submit" disabled={saving}
          className="w-full rounded-lg bg-emerald-600 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm">
          {saving ? 'Saving...' : 'Save Pricing'}
        </button>
      </form>

      {msg && (
        <div className={`text-xs text-center font-medium ${msg.includes('✓') ? 'text-emerald-600' : 'text-red-500'}`}>
          {msg}
        </div>
      )}
    </div>
  )
}

export function PlanActions({ plan }: { plan: ImportedPlanRow }) {
  const [loading, setLoading] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  async function act(fn: string) {
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
    <div className="flex flex-wrap items-center justify-center gap-1 pt-1">
      {isReady ? (
        <button onClick={() => act('unmarkReady')} disabled={!!loading}
          className="rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">Unmark Ready</button>
      ) : (
        <button onClick={() => act('markReady')} disabled={!!loading}
          className="rounded bg-purple-600 px-2 py-0.5 text-[10px] text-white hover:bg-purple-700 disabled:opacity-50 shadow-sm">Mark Ready</button>
      )}
      <button onClick={() => act('publish')} disabled={!!loading}
        className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm">Publish</button>
      <button onClick={() => act('archive')} disabled={!!loading}
        className="rounded border border-red-200 px-2 py-0.5 text-[10px] text-red-500 hover:bg-red-50 disabled:opacity-50">Archive</button>
      {msg && <span className="text-xs text-gray-400">{msg}</span>}
    </div>
  )
}

export default function ImportedPlansActions({ plan }: { plan: ImportedPlanRow }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <InlinePricingForm plan={plan} />
      <PlanActions plan={plan} />
    </div>
  )
}
