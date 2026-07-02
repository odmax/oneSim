'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function publishToCatalog(packageIds: string[]): Promise<{ success: boolean; created?: number; updated?: number; skipped?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  if (!packageIds || packageIds.length === 0) {
    return { success: false, error: 'No packages selected' }
  }

  const providerPackages = await prisma.providerPackage.findMany({
    where: { id: { in: packageIds } },
    include: { provider: { select: { name: true } } },
  })

  let created = 0
  let updated = 0
  let skipped = 0

  for (const pp of providerPackages) {
    const sellPrice = pp.sellingPrice ? parseFloat(pp.sellingPrice.toString()) : null

    // Validation: must have selling price and be configured
    if (!sellPrice || sellPrice <= 0) {
      skipped++
      continue
    }

    const configStatus = pp.configurationStatus || 'UNCONFIGURED'
    if (!['CONFIGURED', 'AUTO_CONFIGURED'].includes(configStatus)) {
      skipped++
      continue
    }

    if (!pp.sellingCurrency) {
      skipped++
      continue
    }

    try {
      // Check if already published
      const existing = await prisma.eSIMPackage.findFirst({
        where: { providerPackageId: pp.id },
      })

      if (existing) {
        // Update existing
        await prisma.eSIMPackage.update({
          where: { id: existing.id },
          data: {
            name: pp.name,
            displayName: pp.name,
            dataGB: pp.dataGB,
            validityDays: pp.validityDays,
            priceUSD: sellPrice,
            localPrice: sellPrice,
            currency: pp.sellingCurrency,
            providerName: pp.provider?.name || null,
            providerPlanId: pp.providerPlanId,
            providerId: pp.providerId,
            costPriceUSD: pp.costPrice,
            costCurrency: pp.currency,
            markupPercent: pp.markupPercent ? parseFloat(pp.markupPercent.toString()) : null,
            source: 'PROVIDER_PLAN',
            isActive: true,
          },
        })
        updated++
      } else {
        // Create new
        const pkg = await prisma.eSIMPackage.create({
          data: {
            name: pp.name,
            displayName: pp.name,
            dataGB: pp.dataGB,
            validityDays: pp.validityDays,
            priceUSD: sellPrice,
            localPrice: sellPrice,
            currency: pp.sellingCurrency,
            providerName: pp.provider?.name || null,
            providerPlanId: pp.providerPlanId,
            providerId: pp.providerId,
            sku: pp.providerPlanCode || undefined,
            packageCode: pp.providerPlanCode || undefined,
            costPriceUSD: pp.costPrice,
            costCurrency: pp.currency,
            markupPercent: pp.markupPercent ? parseFloat(pp.markupPercent.toString()) : null,
            source: 'PROVIDER_PLAN',
            isActive: true,
            providerPackageId: pp.id,
          },
        })
        created++
      }

      // Update provider package status
      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: { publishStatus: 'PUBLISHED' },
      })
    } catch (e: any) {
      console.error(`Failed to publish package ${pp.id}:`, e.message)
      skipped++
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'BULK_PUBLISH_TO_CATALOG',
      entity: 'ProviderPackage',
      details: `Published ${created} new, ${updated} updated, ${skipped} skipped out of ${packageIds.length} selected`,
    },
  }).catch(() => {})

  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')
  revalidatePath('/admin/catalog-products')

  return { success: true, created, updated, skipped }
}

export async function bulkSetPublishStatus(packageIds: string[], status: 'HIDDEN' | 'ARCHIVED'): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }
  if (!packageIds || packageIds.length === 0) return { success: false, error: 'No packages selected' }

  const validStatuses = ['HIDDEN', 'ARCHIVED']
  if (!validStatuses.includes(status)) return { success: false, error: 'Invalid status' }

  const result = await prisma.providerPackage.updateMany({
    where: { id: { in: packageIds } },
    data: { publishStatus: status },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: `BULK_${status}`, entity: 'ProviderPackage', details: `Set ${result.count} packages to ${status}` },
  }).catch(() => {})

  revalidatePath('/admin/provider-catalog')
  return { success: true, updated: result.count }
}

export async function getPublishSummary(packageIds: string[]) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return null

  const packages = await prisma.providerPackage.findMany({
    where: { id: { in: packageIds }, sellingPrice: { not: undefined } },
    include: { provider: { select: { id: true, name: true } } },
  })

  if (packages.length === 0) return { total: 0, providers: [], countries: [], minPrice: 0, maxPrice: 0 }

  const providers = [...new Set(packages.map(p => p.provider?.name).filter(Boolean))]
  const countries = [...new Set(packages.map(p => p.country).filter(Boolean))]
  const prices = packages.map(p => parseFloat(p.sellingPrice!.toString())).filter(p => !isNaN(p))

  return {
    total: packages.length,
    providers: providers.length,
    providerNames: providers.join(', '),
    countries: countries.length,
    countryNames: countries.join(', '),
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
  }
}
