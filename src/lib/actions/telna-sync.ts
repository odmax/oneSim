'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { TelnaConnector } from '@/lib/providers/connectors/telna-connector'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { mapTelnaPackage, computePackageComparableKey } from '@/lib/providers/mappers/telna-package-mapper'
import { computeEffectiveCost } from '@/lib/packages/cheapest-utils'

function isTelnaConnector(c: unknown): c is TelnaConnector {
  return c !== null && typeof c === 'object' && 'listPackages' in c && 'getPackage' in c
}

function makeSignature(mapped: ReturnType<typeof mapTelnaPackage>, comparableKey: string): string {
  return JSON.stringify({
    n: mapped.name,
    d: mapped.dataGB,
    v: mapped.validityDays,
    c: mapped.costPrice,
    u: mapped.currency,
    y: mapped.country,
    r: mapped.region,
    s: mapped.status,
    p: mapped.planType,
    t: mapped.providerTemplateId,
    k: comparableKey,
    a: mapped.isAvailable,
  })
}

export async function telnaSyncPackages(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }

  const pipelineRunId = await startPipelineRun({
    providerId: provider.id,
    providerCode: provider.code || undefined,
    trigger: 'MANUAL',
  })
  const syncStartTime = Date.now()

  try {
    const connector = await buildConnectorFromProvider(providerId)
    if (!connector) return { error: 'Provider not found' }
    if (!isTelnaConnector(connector)) return { error: 'Provider does not support Telna sync' }

    // Paginated fetch all packages
    const allPackages: any[] = []
    let offset = 0
    const PAGE_SIZE = 100
    let hasMore = true

    while (hasMore) {
      const result = await connector.listPackages(undefined, undefined, PAGE_SIZE, offset)
      if (!result.success) {
        await failPipelineRun(pipelineRunId, result.error?.message || 'Failed to list packages')
        return { error: `Failed to list packages: ${result.error?.message}` }
      }
      const items = result.data?.items || []
      allPackages.push(...items)
      const total = result.data?.total || 0
      offset += PAGE_SIZE
      if (offset >= total || items.length === 0) hasMore = false
    }

    const fetched = allPackages.length

    // Map and process
    const processed: Record<string, { action: 'created' | 'updated' | 'skipped'; mapped: ReturnType<typeof mapTelnaPackage>; comparableKey: string }> = {}
    const archiveCandidates: string[] = []

    // Build set of incoming IDs for archive detection
    const incomingIds = new Set<string>()

    for (const raw of allPackages) {
      const mapped = mapTelnaPackage(raw)
      const packageId = mapped.providerPackageId
      if (!packageId) continue
      incomingIds.add(packageId)

      const comparableKey = computePackageComparableKey(mapped)
      const sig = makeSignature(mapped, comparableKey)

      // Check existing
      const existing = await prisma.providerPackage.findFirst({
        where: { providerId, providerPlanId: packageId },
      })

      if (existing) {
        const existingSig = existing.providerRawData
          ? ((existing.providerRawData as Record<string, unknown>)?.__syncSig as string) || ''
          : ''
        if (existingSig === sig && existing.isAvailable && existing.providerStatus === mapped.status) {
          processed[packageId] = { action: 'skipped', mapped, comparableKey }
          continue
        }
        // Update
        const { effectiveCostPrice, costSource } = computeEffectiveCost(
          Number(mapped.costPrice ?? 0),
          existing.adminCostPrice ? Number(existing.adminCostPrice) : null,
        )
        await prisma.providerPackage.update({
          where: { id: existing.id },
          data: {
            providerPlanCode: mapped.providerTemplateId || undefined,
            providerTemplateId: mapped.providerTemplateId,
            providerStatus: mapped.status,
            name: mapped.name,
            dataGB: Math.round(mapped.dataGB ?? 0),
            validityDays: mapped.validityDays ?? 30,
            costPrice: mapped.costPrice ?? 0,
            currency: mapped.currency || 'USD',
            country: mapped.country,
            region: mapped.region,
            planType: mapped.planType,
            isAvailable: mapped.isAvailable,
            comparableKey,
            effectiveCostPrice,
            costSource,
            providerRawData: { ...mapped.rawData, __syncSig: sig },
          },
        })
        processed[packageId] = { action: 'updated', mapped, comparableKey }
      } else {
        // Create
        const { effectiveCostPrice, costSource } = computeEffectiveCost(
          Number(mapped.costPrice ?? 0),
          null,
        )
        await prisma.providerPackage.create({
          data: {
            providerId,
            providerPlanId: packageId,
            providerPlanCode: mapped.providerTemplateId || undefined,
            providerTemplateId: mapped.providerTemplateId,
            providerStatus: mapped.status,
            name: mapped.name,
            dataGB: Math.round(mapped.dataGB ?? 0),
            validityDays: mapped.validityDays ?? 30,
            costPrice: mapped.costPrice ?? 0,
            currency: mapped.currency || 'USD',
            country: mapped.country,
            region: mapped.region,
            planType: mapped.planType,
            isAvailable: mapped.isAvailable,
            comparableKey,
            effectiveCostPrice,
            costSource,
            providerRawData: { ...mapped.rawData, __syncSig: sig },
          },
        })
        processed[packageId] = { action: 'created', mapped, comparableKey }
      }
    }

    // Soft-archive packages removed by Telna
    const existingPackages = await prisma.providerPackage.findMany({
      where: { providerId, isAvailable: true },
      select: { id: true, providerPlanId: true },
    })
    for (const ep of existingPackages) {
      if (!incomingIds.has(ep.providerPlanId)) {
        archiveCandidates.push(ep.id)
      }
    }
    for (const archiveId of archiveCandidates) {
      await prisma.providerPackage.update({
        where: { id: archiveId },
        data: { isAvailable: false, providerStatus: 'ARCHIVED' },
      })
    }

    // Count results
    let created = 0, updated = 0, skipped = 0
    for (const [_, v] of Object.entries(processed)) {
      if (v.action === 'created') created++
      else if (v.action === 'updated') updated++
      else skipped++
    }
    const archived = archiveCandidates.length
    const durationMs = Date.now() - syncStartTime

    // Log diagnostics
    console.log(`[TELNA_PACKAGE_SYNC] provider=${provider.code} fetched=${fetched} created=${created} updated=${updated} archived=${archived} skipped=${skipped} duration=${durationMs}ms`)

    // Update provider sync metadata
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncCount: fetched,
        lastSyncResult: `Synced ${fetched} packages: ${created}c ${updated}u ${archived}a ${skipped}s`,
      },
    })

    // Record pipeline stage
    await recordStageFromCounts({
      pipelineRunId,
      stage: 'PROVIDER_SYNC',
      startTime: syncStartTime,
      total: fetched,
      passed: created + updated,
      failed: 0,
      skipped: archived + skipped,
      metadata: { created, updated, archived, skipped, fetched },
    })
    await completePipelineRun(
      pipelineRunId,
      'SUCCESS',
      created + updated,
    )

    // Emit events
    const { emitEvent } = await import('@/lib/catalog-events')
    for (const [pkgId, info] of Object.entries(processed)) {
      if (info.action === 'created') {
        emitEvent({
          eventType: 'PACKAGE_CREATED',
          providerId,
          providerCode: provider.code,
          packageId: pkgId,
          comparableKey: info.comparableKey,
          changedFields: [],
          trigger: 'USER_ACTION',
          userId: session.user.id,
          metadata: { name: info.mapped.name, dataGB: info.mapped.dataGB },
        })
      } else if (info.action === 'updated') {
        emitEvent({
          eventType: 'PACKAGE_UPDATED',
          providerId,
          providerCode: provider.code,
          packageId: pkgId,
          comparableKey: info.comparableKey,
          changedFields: ['provider_data'],
          trigger: 'USER_ACTION',
          userId: session.user.id,
          metadata: { name: info.mapped.name },
        })
      }
    }
    for (const archivePkgId of existingPackages.filter(ep => incomingIds.has(ep.providerPlanId) === false)) {
      emitEvent({
        eventType: 'PACKAGE_ARCHIVED',
        providerId,
        providerCode: provider.code,
        packageId: archivePkgId.providerPlanId,
        comparableKey: null,
        changedFields: ['isAvailable', 'providerStatus'],
        trigger: 'USER_ACTION',
        userId: session.user.id,
        metadata: {},
      })
    }
    emitEvent({
      eventType: 'PROVIDER_SYNC_COMPLETED',
      providerId,
      providerCode: provider.code,
      packageId: null,
      comparableKey: null,
      changedFields: [],
      trigger: 'USER_ACTION',
      userId: session.user.id,
      metadata: { created, updated, archived, skipped, total: fetched },
    })

    return {
      success: true,
      result: { fetched, created, updated, archived, skipped, durationMs },
    }
  } catch (error: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncResult: `Sync failed: ${error.message || 'Unknown error'}`,
        lastSyncCount: 0,
      },
    })
    await recordStageFromCounts({
      pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime,
      total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED',
      metadata: { error: error.message || 'Unknown' },
    })
    await failPipelineRun(pipelineRunId, error.message || 'Unknown error')
    return { error: `Sync failed: ${error.message || 'Unknown error'}` }
  }
}
