'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { runCatalogAutomation } from '@/lib/catalog/catalog-automation'
import { runCatalogPipeline } from '@/lib/catalog/catalog-pipeline'
import { markSellingPriceByPercent, computeMarginFromCostAndSell } from '@/lib/pricing/pricing-engine'
import { optimizePackage } from '@/lib/pricing/provider-optimization'
import type { PipelineResult } from '@/lib/catalog/catalog-pipeline'
import type { ProviderIntelligenceInput } from '@/lib/pricing/provider-intelligence'
import type { OptimizationRules } from '@/lib/pricing/provider-optimization'

export async function runFullCatalogPipeline(
  providerId?: string,
  ruleId?: string,
  optimizationRules?: OptimizationRules,
): Promise<{ success: boolean; data?: PipelineResult; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const where: any = { isAvailable: true }
  if (providerId) where.providerId = providerId

  const packages = await prisma.providerPackage.findMany({
    where,
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })

  // ── Step 1: Catalog Automation ──
  const automationInputs = packages.map(pp => ({
    packageId: pp.id,
    packageName: pp.name,
    providerId: pp.providerId,
    providerName: pp.provider.name,
    providerCode: pp.provider.code,
    before: null,
    after: {
      cost: parseFloat(pp.costPrice.toString()),
      data: pp.dataGB,
      validity: pp.validityDays,
      country: pp.country || undefined,
      name: pp.name,
    },
    hasPricing: !!(pp.sellingPrice && parseFloat(pp.sellingPrice.toString()) > 0),
    isPublished: pp.publishStatus === 'PUBLISHED',
  }))

  const automation = runCatalogAutomation(automationInputs)

  // ── Step 2: Simulation + Catalog Pricing ──
  const simulations = new Map<string, { sellingPrice: number; marginPercent: number } | null>()
  const catalogPrices = new Map<string, { sellingPrice: number; marginPercent: number; currentProvider: string } | null>()

  for (const pp of packages) {
    const sellPrice = pp.sellingPrice ? parseFloat(pp.sellingPrice.toString()) : 0
    const markupPct = pp.markupPercent ? parseFloat(pp.markupPercent.toString()) : 0
    const cost = parseFloat(pp.costPrice.toString())

    // Current catalog pricing
    if (sellPrice > 0 && cost > 0) {
      catalogPrices.set(pp.id, {
        sellingPrice: sellPrice,
        marginPercent: computeMarginFromCostAndSell(cost, sellPrice) ?? 0,
        currentProvider: pp.provider.name,
      })
    }

    // Simulate: if a rule is provided, compute what the rule would set
    if (ruleId && sellPrice <= 0 && markupPct > 0 && cost > 0) {
      const simSell = markSellingPriceByPercent(cost, markupPct)
      simulations.set(pp.id, {
        sellingPrice: simSell,
        marginPercent: computeMarginFromCostAndSell(cost, simSell) ?? 0,
      })
    }
  }

  // ── Step 3: Provider Optimization ──
  const optimizations = new Map<string, any | null>()
  const rules = optimizationRules || { strategy: 'LOWEST_COST' as const, allowSwitching: true }

  // Group by comparableKey for provider comparison
  const byKey = new Map<string, any[]>()
  for (const pp of packages) {
    if (pp.comparableKey) {
      const group = byKey.get(pp.comparableKey) || []
      group.push(pp)
      byKey.set(pp.comparableKey, group)
    }
  }

  for (const [key, group] of byKey) {
    const priced = group.find((g: any) => g.sellingPrice && parseFloat(g.sellingPrice.toString()) > 0)
    const sellPrice = priced?.sellingPrice ? parseFloat(priced.sellingPrice.toString()) : null
    const currency = priced?.sellingCurrency || 'USD'

    const intelInputs: ProviderIntelligenceInput[] = group.map((g: any) => ({
      packageId: g.id,
      packageName: g.name,
      providerId: g.providerId,
      providerCode: g.provider.code,
      providerName: g.provider.name,
      providerStatus: g.provider.status,
      costPrice: parseFloat(g.costPrice.toString()),
      effectiveCostPrice: g.effectiveCostPrice ? parseFloat(g.effectiveCostPrice.toString()) : null,
      dataGB: g.dataGB,
      validityDays: g.validityDays,
      currentProviderPackageId: null,
    }))

    for (const input of intelInputs) {
      try {
        const opt = optimizePackage(intelInputs, sellPrice, key, rules, currency)
        optimizations.set(input.packageId, opt)
      } catch {
        optimizations.set(input.packageId, null)
      }
    }
  }

  // ── Step 4: Run pipeline orchestrator ──
  const result = runCatalogPipeline({
    automation,
    simulations: simulations.size > 0 ? simulations : undefined,
    catalogPrices: catalogPrices.size > 0 ? catalogPrices : undefined,
    optimizations: optimizations.size > 0 ? optimizations : undefined,
    currency: 'USD',
  })

  return { success: true, data: result }
}
