'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  roundMoney,
  roundPercentage,
  calculatePricing,
  computeMarkupFromCostAndSell,
} from '@/lib/pricing/pricing-engine'
import type { PricingStrategy } from '@/lib/pricing/pricing-engine'

export type PricingMethod = 'MARKUP_PERCENT' | 'MARGIN_PERCENT' | 'FIXED_SELLING_PRICE' | 'FIXED_PROFIT'

export interface PricingPreviewResult {
  sellingPrice: number
  profit: number
  markupPercent: number
  marginPercent: number
}

interface Props {
  defaultMethod?: PricingMethod
  defaultValue?: number
  cost?: number
  showCost?: boolean
  namePrefix?: string
  onValuesChange?: (values: { markupPercent?: number; fixedPrice?: number; costPrice?: number }) => void
}

const METHOD_OPTIONS: { value: PricingMethod; label: string }[] = [
  { value: 'MARKUP_PERCENT', label: 'Markup %' },
  { value: 'MARGIN_PERCENT', label: 'Margin %' },
  { value: 'FIXED_SELLING_PRICE', label: 'Fixed Selling Price' },
  { value: 'FIXED_PROFIT', label: 'Fixed Profit' },
]

const METHOD_INPUT_LABELS: Record<PricingMethod, string> = {
  MARKUP_PERCENT: 'Markup %',
  MARGIN_PERCENT: 'Margin %',
  FIXED_SELLING_PRICE: 'Selling Price (USD)',
  FIXED_PROFIT: 'Target Profit (USD)',
}

export default function PricingMethodSelector({
  defaultMethod = 'MARKUP_PERCENT',
  defaultValue,
  cost,
  showCost = true,
  namePrefix,
  onValuesChange,
}: Props) {
  const [method, setMethod] = useState<PricingMethod>(defaultMethod)
  const [value, setValue] = useState<number | undefined>(defaultValue)
  const [localCost, setLocalCost] = useState<number | undefined>(cost)

  const preview = (() => {
    if (localCost == null || localCost < 0 || value == null || value < 0 || !isFinite(localCost) || !isFinite(value)) return null
    if (localCost === 0) return null
    if (method === 'MARGIN_PERCENT' && value >= 100) return null
    if (method === 'FIXED_SELLING_PRICE' && value < localCost) return null

    const strategy = method as PricingStrategy
    const result = calculatePricing({ cost: localCost, strategy, value })
    return {
      sellingPrice: result.sellingPrice,
      profit: result.profit,
      markupPercent: result.markupPercent,
      marginPercent: result.marginPercent,
    }
  })()

  const emit = useCallback((m: PricingMethod, v: number | undefined, c: number | undefined) => {
    if (!onValuesChange) return
    if (c == null || v == null || c <= 0 || !isFinite(v)) {
      onValuesChange({})
      return
    }
    switch (m) {
      case 'MARKUP_PERCENT':
        onValuesChange({ markupPercent: v })
        break
      case 'MARGIN_PERCENT': {
        if (v >= 100) { onValuesChange({}); return }
        const result = calculatePricing({ cost: c, strategy: 'MARGIN_PERCENT', value: v })
        onValuesChange({ markupPercent: result.markupPercent })
        break
      }
      case 'FIXED_SELLING_PRICE':
        onValuesChange({ fixedPrice: v })
        break
      case 'FIXED_PROFIT':
        onValuesChange({ fixedPrice: roundMoney(c + v) })
        break
    }
  }, [onValuesChange])

  useEffect(() => {
    emit(method, value, localCost)
  }, [method, value, localCost, emit])

  useEffect(() => {
    if (cost != null) setLocalCost(cost)
  }, [cost])

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Pricing Method</label>
          <select
            value={method}
            onChange={e => setMethod(e.target.value as PricingMethod)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white"
          >
            {METHOD_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            {METHOD_INPUT_LABELS[method]}
          </label>
          <input
            name={namePrefix ? `${namePrefix}_value` : 'pricingMethodValue'}
            type="number"
            step="0.01"
            min="0"
            value={value ?? ''}
            onChange={e => setValue(e.target.value ? parseFloat(e.target.value) : undefined)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white"
          />
        </div>
      </div>

      {showCost && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Cost Price <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            name="costPrice"
            type="number"
            step="0.01"
            min="0"
            value={localCost ?? ''}
            onChange={e => setLocalCost(e.target.value ? parseFloat(e.target.value) : undefined)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white"
          />
        </div>
      )}

      {preview && localCost && localCost > 0 && (
        <div className="rounded-lg bg-gradient-to-r from-cyan-50 to-emerald-50 border border-cyan-100 p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Live Preview</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-xs text-gray-400">Selling Price</p>
              <p className="text-lg font-bold text-cyan-700">${preview.sellingPrice.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Profit</p>
              <p className="text-lg font-bold text-emerald-700">${preview.profit.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Markup %</p>
              <p className="text-sm font-semibold text-gray-700">{preview.markupPercent.toFixed(2)}%</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Margin %</p>
              <p className="text-sm font-semibold text-gray-700">{preview.marginPercent.toFixed(2)}%</p>
            </div>
          </div>
        </div>
      )}

      {method === 'MARGIN_PERCENT' && value != null && value >= 100 && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">Margin must be less than 100%</div>
      )}

      {method === 'FIXED_SELLING_PRICE' && value != null && localCost != null && value < localCost && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">Selling price is below cost</div>
      )}

      {namePrefix != null && (
        <>
          <input type="hidden" name="markupPercent" value={
            method === 'MARGIN_PERCENT' && value != null && value < 100
              ? (() => { const r = calculatePricing({ cost: localCost ?? 0, strategy: 'MARGIN_PERCENT', value }); return r.markupPercent })()
              : method === 'MARKUP_PERCENT' ? value ?? '' :
              localCost && value && value > localCost ? computeMarkupFromCostAndSell(localCost, value) ?? '' : ''
          } />
          <input type="hidden" name="fixedPrice" value={
            method === 'FIXED_SELLING_PRICE' ? value ?? '' :
            method === 'FIXED_PROFIT' && value != null && localCost != null ? roundMoney(localCost + value) : ''
          } />
        </>
      )}
    </div>
  )
}
