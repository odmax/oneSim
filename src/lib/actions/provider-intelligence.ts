'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { analyzeProviderGroup } from '@/lib/pricing/provider-intelligence'
import type { ProviderRecommendation } from '@/lib/pricing/provider-intelligence'

/**
 * Get provider intelligence for a specific ProviderPackage.
 *
 * Finds all packages with the same `comparableKey`, then analyses
 * which provider offers the best cost, profit, and margin.
 *
 * Returns a recommendation only — NO database writes.
 */
export async function getProviderIntelligence(
  providerPackageId: string,
): Promise<{ success: boolean; data?: ProviderRecommendation; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const pkg = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })
  if (!pkg) return { success: false, error: 'Package not found' }

  const comparableKey = pkg.comparableKey
  if (!comparableKey) {
    // Fallback: analyse just this package alone
    const result = analyzeProviderGroup(
      [{
        packageId: pkg.id,
        packageName: pkg.name,
        providerId: pkg.providerId,
        providerCode: pkg.provider.code,
        providerName: pkg.provider.name,
        providerStatus: pkg.provider.status,
        costPrice: parseFloat(pkg.costPrice.toString()),
        effectiveCostPrice: pkg.effectiveCostPrice ? parseFloat(pkg.effectiveCostPrice.toString()) : null,
        dataGB: pkg.dataGB,
        validityDays: pkg.validityDays,
        currentProviderPackageId: pkg.id,
      }],
      pkg.sellingPrice ? parseFloat(pkg.sellingPrice.toString()) : null,
      null,
      pkg.sellingCurrency || 'USD',
    )
    return { success: true, data: result }
  }

  // Find all packages with the same comparableKey
  const group = await prisma.providerPackage.findMany({
    where: { comparableKey, isAvailable: true },
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })

  // Determine the catalog selling price — use the first package with a selling price
  const priced = group.find(g => g.sellingPrice && parseFloat(g.sellingPrice.toString()) > 0)
  const catalogSellingPrice = priced?.sellingPrice ? parseFloat(priced.sellingPrice.toString()) : null
  const currency = priced?.sellingCurrency || pkg.sellingCurrency || 'USD'

  const result = analyzeProviderGroup(
    group.map(g => ({
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
      currentProviderPackageId: pkg.id,
    })),
    catalogSellingPrice,
    comparableKey,
    currency,
  )

  return { success: true, data: result }
}
