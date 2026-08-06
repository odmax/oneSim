'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { emitEvent } from '@/lib/catalog-events'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import { finalizeCatalogPackageConfiguration } from '@/lib/pricing/configuration-finalizer'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'

function shortCode(s: string | null | undefined, fallback: string): string {
  if (!s) return fallback
  return s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
}

function shortId(id: string): string {
  return id.slice(-6).toUpperCase()
}

async function generateOneSimSku(tx: any, pp: {
  id: string
  provider?: { code?: string | null; name?: string | null } | null
  country?: string | null
  dataGB: number
  validityDays: number
}): Promise<string> {
  const provCode = shortCode(pp.provider?.code || pp.provider?.name, 'XX')
  const country = (pp.country || 'XX').toUpperCase()
  const base = `OS-${provCode}-${country}-${pp.dataGB}GB-${pp.validityDays}D-${shortId(pp.id)}`

  let sku = base
  let attempt = 0
  while (attempt < 100) {
    const exists = await tx.eSIMPackage.findUnique({ where: { sku }, select: { id: true } })
    if (!exists) return sku
    attempt++
    sku = `${base}-${attempt}`
  }
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

  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL', totalInput: packageIds.length })
  const publishStart = Date.now()

  let created = 0
  let updated = 0
  let skipped = 0
  const skippedDetails: { packageId: string; name: string; reason: string }[] = []

  const qualified: typeof providerPackages = []
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

    qualified.push(pp)
  }

  if (qualified.length > 0) {
    for (const pp of qualified) {
      const result = await publishProviderPackageToRetailCatalog(pp.id, { reason: 'PUBLISH' })

      if (!result.success) {
        skipped++
        skippedDetails.push({ packageId: pp.id, name: pp.name, reason: `publish failed: ${result.error || 'unknown'} (stage: ${result.failedStage})` })
        continue
      }

      if (result.created) created++
      else updated++

      console.log(`[publishToCatalog] ${pp.name}: ${result.created ? 'created' : 'updated'} retail ${result.retailPackageId}, ready=${result.ready}`)
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

  await recordStageFromCounts({
    pipelineRunId, stage: 'PUBLISH', startTime: publishStart,
    total: providerPackages.length, passed: created + updated, failed: 0, skipped,
    metadata: { created, updated, skippedDetails: skippedDetails.slice(0, 10) },
  })
  await completePipelineRun(pipelineRunId, skipped > 0 && created + updated === 0 ? 'FAILED' : skipped > 0 ? 'PARTIAL' : 'SUCCESS', created + updated)

  emitEvent({
    eventType: 'CATALOG_PUBLISHED',
    providerId: null,
    providerCode: null,
    packageId: null,
    comparableKey: null,
    changedFields: [],
    trigger: 'USER_ACTION',
    userId: session.user.id,
    metadata: { created, updated, skipped, total: providerPackages.length },
  })

  await revalidateCatalogRoutes()

  return { success: true, created, updated, skipped, skippedDetails }
}

export async function bulkSetPublishStatus(packageIds: string[], status: 'HIDDEN' | 'ARCHIVED'): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }
  if (!packageIds || packageIds.length === 0) return { success: false, error: 'No packages selected' }

  const validStatuses = ['HIDDEN', 'ARCHIVED']
  if (!validStatuses.includes(status)) return { success: false, error: 'Invalid status' }

  await prisma.$transaction(async (tx) => {
    await tx.providerPackage.updateMany({
      where: { id: { in: packageIds } },
      data: { publishStatus: status },
    })

    await tx.eSIMPackage.updateMany({
      where: { providerPackageId: { in: packageIds } },
      data: { isActive: status === 'HIDDEN' ? false : undefined },
    })
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: `BULK_${status}`, entity: 'ProviderPackage', details: `Set ${packageIds.length} packages to ${status}` },
  }).catch(() => {})

  await revalidateCatalogRoutes()
  return { success: true, updated: packageIds.length }
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
