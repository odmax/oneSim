'use client'

import { useState } from 'react'
import type { ImportedPlanRow } from '@/lib/actions/imported-plans'

export function InlinePricingForm({ plan, onSaved, onClose }: { plan: ImportedPlanRow; onSaved: () => void; onClose: () => void }) {
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [costInput, setCostInput] = useState(plan.adminCostPrice != null ? String(plan.adminCostPrice) : '')
  const [sellInput, setSellInput] = useState(plan.sellingPrice != null ? String(plan.sellingPrice) : '')

  const providerCost = plan.providerCostPrice
  const effCost = plan.effectiveCostPrice
  const hasProviderCost = providerCost > 0
  const hasCost = effCost != null && effCost > 0
  const hasSell = plan.sellingPrice != null && plan.sellingPrice > 0

  async function handleSave(formData: FormData) {
    setSaving(true); setMsg('')
    try {
      const { saveImportedPlanPricing } = await import('@/lib/actions/imported-plans')
      const res = await saveImportedPlanPricing(formData)
      if (res.success) {
        setMsg('Pricing saved ✓')
        setTimeout(() => { onClose(); onSaved() }, 400)
      } else setMsg(res.error || 'Failed to save')
    } catch (e: any) { setMsg(e.message || 'Error') }
    setSaving(false)
  }

  return (
    <div className="w-44">
      <form action={handleSave} className="space-y-1">
        <input type="hidden" name="providerPackageId" value={plan.providerPackageId} />

        {!hasProviderCost && (
          <div className="flex items-center justify-between text-[10px] text-gray-400">
            <span>Provider Cost</span><span className="font-mono">$0.00</span>
          </div>
        )}

        <input name="adminCostPrice" type="text" inputMode="decimal"
          value={costInput} onChange={e => setCostInput(e.target.value)}
          placeholder={hasProviderCost ? 'Override cost' : 'Cost price *'}
          className={`w-full rounded border px-2 py-1 text-xs font-mono ${!costInput ? 'border-amber-300 bg-amber-50' : 'border-gray-200'} focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500`}
        />

        <input name="sellingPrice" type="text" inputMode="decimal"
          value={sellInput} onChange={e => setSellInput(e.target.value)}
          placeholder="Sell price *"
          className="w-full rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />

        {(!costInput || !sellInput) && <p className="text-[10px] text-amber-600">Set cost and sell price first.</p>}

        <div className="flex gap-1">
          <button type="submit" disabled={saving}
            className="flex-1 rounded bg-emerald-600 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {saving ? '...' : 'Save'}
          </button>
          <button type="button" onClick={onClose}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500">Close</button>
        </div>
      </form>
      {msg && <p className={`text-[10px] text-center mt-1 ${msg.includes('✓') ? 'text-emerald-600' : 'text-red-500'}`}>{msg}</p>}
    </div>
  )
}

function Btn({ onClick, label, color, disabled, slim }: { onClick: () => void; label: string; color: string; disabled?: boolean; slim?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium ${color} disabled:opacity-50 disabled:cursor-not-allowed ${slim ? '' : ''}`}>
      {label}
    </button>
  )
}

export default function ImportedPlansActions({ plan }: { plan: ImportedPlanRow }) {
  const [showPricing, setShowPricing] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const effCost = plan.effectiveCostPrice
  const hasCost = effCost != null && effCost > 0
  const hasSell = plan.sellingPrice != null && plan.sellingPrice > 0
  const isConfigured = hasCost && hasSell
  const isReady = plan.readyToPublish

  async function act(fn: string) {
    setLoading(fn); setMsg('')
    try {
      const mod = await import('@/lib/actions/imported-plans')
      let res: any
      if (fn === 'publish') { const fd = new FormData(); fd.set('providerPackageId', plan.providerPackageId); res = await mod.publishImportedPlan(fd) }
      else if (fn === 'markReady') res = await mod.markReadyToPublish(plan.providerPackageId)
      else if (fn === 'unmarkReady') res = await mod.unmarkReadyToPublish(plan.providerPackageId)
      else if (fn === 'archive') res = await mod.archiveImportedPlan(plan.providerPackageId)
      if (res?.success) { window.location.reload() }
      else setMsg(res?.error || 'Error')
    } catch (e: any) { setMsg(e.message || 'Error') }
    setLoading(null)
  }

  function onSaved() {
    setShowPricing(false)
    window.location.reload()
  }

  // --- Archived: just restore ---
  if (plan.status === 'archived') {
    return <Btn onClick={() => act('restore')} label="Restore" color="border border-gray-300 text-gray-600 hover:bg-gray-50" slim />
  }

  // --- Published: edit + link ---
  if (plan.status === 'published') {
    return (
      <div className="flex flex-wrap justify-center gap-1">
        <Btn onClick={() => setShowPricing(!showPricing)} label={showPricing ? 'Close' : 'Edit Pricing'} color="border border-gray-200 text-gray-600 hover:bg-gray-50" slim />
        <a href={`/admin/packages/${plan.packageId}/edit`} className="whitespace-nowrap rounded border border-emerald-200 px-2 py-1 text-[11px] font-medium text-emerald-600 hover:bg-emerald-50">View Product</a>
      {showPricing && <InlinePricingForm plan={plan} onSaved={onSaved} onClose={() => setShowPricing(false)} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center">
      {/* Pricing form (collapsible) */}
        {showPricing && <InlinePricingForm plan={plan} onSaved={onSaved} onClose={() => setShowPricing(false)} />}

      {!showPricing && (
        <>
          {/* Compact summary when not editing */}
          <div className="flex flex-wrap justify-center gap-1">
            {/* Primary action: Set/Edit Pricing */}
            <Btn onClick={() => setShowPricing(true)}
              label={!isConfigured ? 'Set Pricing' : 'Edit Pricing'}
              color={!isConfigured ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}
              slim
            />

            {/* Ready / Publish for configured plans */}
            {isConfigured && (
              <>
                {isReady ? (
                  <Btn onClick={() => act('unmarkReady')} label="Unmark" color="border border-purple-200 text-purple-600 hover:bg-purple-50" slim />
                ) : (
                  <Btn onClick={() => act('markReady')} label="Mark Ready" color="bg-purple-600 text-white hover:bg-purple-700 shadow-sm" slim />
                )}
                <Btn onClick={() => act('publish')} label="Publish" color="bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm" disabled={!isReady} slim />
              </>
            )}

            {/* Archive always available */}
            <Btn onClick={() => act('archive')} label="Archive" color="border border-red-200 text-red-500 hover:bg-red-50" slim />
          </div>
          {msg && <p className="text-[10px] text-red-500 mt-1">{msg}</p>}
        </>
      )}
    </div>
  )
}
