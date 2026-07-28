'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { batchOptimize } from '@/lib/pricing/provider-optimization'
import type { OptimizationRules, BatchOptimizationResult } from '@/lib/pricing/provider-optimization'

export async function runBatchOptimization(
  providerId?: string,
  country?: string,
  rules: OptimizationRules = { strategy: 'LOWEST_COST', allowSwitching: true },
): Promise<{ success: boolean; data?: BatchOptimizationResult; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  // Fetch all distinct comparable keys
  const where: any = { isAvailable: true, comparableKey: { not: null } }
  if (providerId) where.providerId = providerId
  if (country) where.country = country

  const keys = await prisma.providerPackage.findMany({
    where,
    select: { comparableKey: true },
    distinct: ['comparableKey'],
  })

  const groups: Array<{
    comparableKey: string | null
    packages: any[]
    catalogSellingPrice: number | null
    currency: string
  }> = []

  for (const { comparableKey } of keys) {
    if (!comparableKey) continue

    const pkgs = await prisma.providerPackage.findMany({
      where: { comparableKey, isAvailable: true },
      include: { provider: { select: { id: true, name: true, code: true, status: true } } },
    })

    const priced = pkgs.find(p => p.sellingPrice && parseFloat(p.sellingPrice.toString()) > 0)
    const catalogSellingPrice = priced?.sellingPrice ? parseFloat(priced.sellingPrice.toString()) : null
    const currency = priced?.sellingCurrency || 'USD'

    groups.push({
      comparableKey,
      packages: pkgs.map(p => ({
        packageId: p.id,
        packageName: p.name,
        providerId: p.providerId,
        providerCode: p.provider.code,
        providerName: p.provider.name,
        providerStatus: p.provider.status,
        costPrice: parseFloat(p.costPrice.toString()),
        effectiveCostPrice: p.effectiveCostPrice ? parseFloat(p.effectiveCostPrice.toString()) : null,
        dataGB: p.dataGB,
        validityDays: p.validityDays,
        currentProviderPackageId: null,
      })),
      catalogSellingPrice,
      currency,
    })
  }

  const result = batchOptimize(groups, rules)
  return { success: true, data: result }
}
