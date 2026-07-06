'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

function shortCode(s: string | null | undefined, fallback: string): string {
  if (!s) return fallback
  return s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
}

function shortId(id: string): string {
  return id.slice(-6).toUpperCase()
}

async function generateOneSimSku(pp: {
  id: string
  provider?: { code?: string | null; name?: string | null } | null
  country?: string | null
  dataGB: number
  validityDays: number
}): Promise<string> {
  const provCode = shortCode(pp.provider?.code || pp.provider?.name, 'XX')
  const country = (pp.country || 'XX').toUpperCase()
  const base = `OS-${provCode}-${country}-${pp.dataGB}GB-${pp.validityDays}D-${shortId(pp.id)}`

  // Collision guard: if generated SKU exists, append sequential suffix
  let sku = base
  let attempt = 0
  while (attempt < 100) {
    const exists = await prisma.eSIMPackage.findUnique({ where: { sku }, select: { id: true } })
    if (!exists) return sku
    attempt++
    sku = `${base}-${attempt}`
  }
  // Fallback with full ID — practically impossible to collide
  return `${base}-${pp.id.slice(-8).toUpperCase()}`
}

export async function publishToCatalog(packageIds: string[]): Promise<{
  success: boolean
  created?: number
  updated?: number
  skipped?: number
  skippedDetails?: { packageId: string; name: string; reason: string }[]
  error?: string
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  if (!packageIds || packageIds.length === 0) {
    return { success: false, error: 'No packages selected' }
  }

  const providerPackages = await prisma.providerPackage.findMany({
    where: { id: { in: packageIds } },
    include: { provider: { select: { name: true, code: true } } },
  })

  console.log(`[publishToCatalog] Selected: ${packageIds.length} | Found in DB: ${providerPackages.length}`)

  let created = 0
  let updated = 0
  let skipped = 0
  const skippedDetails: { packageId: string; name: string; reason: string }[] = []

  for (const pp of providerPackages) {
    const sellPrice = pp.sellingPrice ? parseFloat(pp.sellingPrice.toString()) : null
    const costPrice = pp.costPrice ? parseFloat(pp.costPrice.toString()) : null

    if (!costPrice || costPrice <= 0) {
      skipped++
      skippedDetails.push({ packageId: pp.id, name: pp.name, reason: 'missing costPrice' })
      continue
    }

    if (!sellPrice || sellPrice <= 0) {
      skipped++
      skippedDetails.push({ packageId: pp.id, name: pp.name, reason: 'missing sellingPrice' })
      continue
    }

    const configStatus = pp.configurationStatus || 'UNCONFIGURED'
    if (!['CONFIGURED', 'AUTO_CONFIGURED'].includes(configStatus)) {
      skipped++
      skippedDetails.push({ packageId: pp.id, name: pp.name, reason: `not configured (status: ${configStatus})` })
      continue
    }

    if (!pp.sellingCurrency) {
      skipped++
      skippedDetails.push({ packageId: pp.id, name: pp.name, reason: 'missing sellingCurrency' })
      continue
    }

    try {
      const existing = await prisma.eSIMPackage.findFirst({
        where: { providerPackageId: pp.id },
      })

      if (existing) {
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
            source: 'CATALOG_PRODUCT',
            isActive: true,
          },
        })
        updated++
      } else {
        const sku = await generateOneSimSku(pp)
        await prisma.eSIMPackage.create({
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
            sku,
            packageCode: sku,
            costPriceUSD: pp.costPrice,
            costCurrency: pp.currency,
            markupPercent: pp.markupPercent ? parseFloat(pp.markupPercent.toString()) : null,
            source: 'CATALOG_PRODUCT',
            isActive: true,
            providerPackageId: pp.id,
          },
        })
        created++
      }

      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: { publishStatus: 'PUBLISHED' },
      })
    } catch (e: any) {
      skipped++
      let reason = e.message || 'unknown error'
      if (e.code === 'P2002') reason = `duplicate SKU/packageCode (${pp.providerPlanCode || 'none'})`
      skippedDetails.push({ packageId: pp.id, name: pp.name, reason: `create/update failed: ${reason}` })
      console.error(`[publishToCatalog] Failed: ${pp.name} (${pp.id}) — ${reason}`)
    }
  }

  console.log(`[publishToCatalog] Result: created=${created} updated=${updated} skipped=${skipped}`)
  if (skippedDetails.length > 0) {
    console.log(`[publishToCatalog] Skipped details:`, JSON.stringify(skippedDetails.slice(0, 10)))
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

  return { success: true, created, updated, skipped, skippedDetails }
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
    where: { id: { in: packageIds }, sellingPrice: { gt: 0 }, costPrice: { gt: 0 } },
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

export async function getReadySummary() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return null

  const ready = await prisma.providerPackage.count({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      sellingPrice: { gt: 0 },
      costPrice: { gt: 0 },
      sellingCurrency: { not: null },
    },
  })

  const totalMatching = await prisma.providerPackage.count({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
    },
  })

  const missingCost = await prisma.providerPackage.count({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      costPrice: { lte: 0 },
    },
  })

  const missingSell = await prisma.providerPackage.count({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      sellingPrice: { lte: 0 },
    },
  })

  const missingCurrency = await prisma.providerPackage.count({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      sellingPrice: { gt: 0 },
      costPrice: { gt: 0 },
      sellingCurrency: null,
    },
  })

  const reasons: string[] = []
  if (missingCost > 0) reasons.push(`${missingCost} missing cost price`)
  if (missingSell > 0) reasons.push(`${missingSell} missing selling price`)
  if (missingCurrency > 0) reasons.push(`${missingCurrency} missing currency`)

  return {
    totalReady: ready,
    totalMatching,
    publishable: ready,
    skipped: totalMatching - ready,
    skippedReasons: reasons,
  }
}

export async function publishAllReady(): Promise<{
  success: boolean
  totalReady?: number
  publishable?: number
  skipped?: number
  created?: number
  updated?: number
  skippedReasons?: string[]
  skippedDetails?: { packageId: string; name: string; reason: string }[]
  error?: string
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const readyPackages = await prisma.providerPackage.findMany({
    where: {
      publishStatus: { in: ['READY', 'DRAFT'] },
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      sellingPrice: { gt: 0 },
      costPrice: { gt: 0 },
      sellingCurrency: { not: null },
    },
    select: { id: true, name: true },
  })

  console.log(`[publishAllReady] Found ${readyPackages.length} ready packages`)

  if (readyPackages.length === 0) {
    return { success: false, totalReady: 0, error: 'No ready packages found with valid pricing.' }
  }

  const ids = readyPackages.map(p => p.id)
  const result = await publishToCatalog(ids)

  return {
    success: result.success,
    totalReady: readyPackages.length,
    publishable: readyPackages.length,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    skippedDetails: result.skippedDetails,
  }
}
