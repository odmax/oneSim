'use client'

import PricingMethodSelector, { type PricingMethod } from './PricingMethodSelector'

interface Props {
  editRule?: {
    markupPercent?: { toString(): string } | null
    fixedPrice?: { toString(): string } | null
    costPrice?: { toString(): string } | null
  } | null
}

function inferPricingMethod(rule: Props['editRule']): PricingMethod {
  if (rule?.fixedPrice && parseFloat(rule.fixedPrice.toString()) > 0) return 'FIXED_SELLING_PRICE'
  if (rule?.markupPercent && parseFloat(rule.markupPercent.toString()) > 0) return 'MARKUP_PERCENT'
  return 'MARKUP_PERCENT'
}

function inferDefaultValue(rule: Props['editRule']): number | undefined {
  if (rule?.fixedPrice && parseFloat(rule.fixedPrice.toString()) > 0) {
    return parseFloat(rule.fixedPrice.toString())
  }
  if (rule?.markupPercent && parseFloat(rule.markupPercent.toString()) > 0) {
    return parseFloat(rule.markupPercent.toString())
  }
  return undefined
}

export default function RulePricingFields({ editRule }: Props) {
  const method = inferPricingMethod(editRule)
  const value = inferDefaultValue(editRule)
  const cost = editRule?.costPrice ? parseFloat(editRule.costPrice.toString()) : undefined

  return (
    <PricingMethodSelector
      defaultMethod={method}
      defaultValue={value}
      cost={cost}
      showCost={true}
      namePrefix="rule"
    />
  )
}
