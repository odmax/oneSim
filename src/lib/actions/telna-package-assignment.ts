'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { TelnaConnector } from '@/lib/providers/connectors/telna-connector'
import { mapTelnaPCRProfile } from '@/lib/providers/mappers/telna-pcr-profile-mapper'
import { mapTelnaSimRegistry } from '@/lib/providers/mappers/telna-sim-mapper'

function isTelnaConnector(c: unknown): c is TelnaConnector {
  return c !== null && typeof c === 'object' && 'getSimPCRProfile' in c && 'updateSimPCRProfile' in c
}

function safeAdminMessage(error: any, context: string): string {
  const msg = error?.message || String(error) || 'Unknown error'
  if (msg.includes('401') || error?.code === 'HTTP_401') return 'Authentication rejected — check provider credentials'
  if (msg.includes('403') || error?.code === 'HTTP_403') return 'Provider access denied for this operation'
  if (msg.includes('404') || error?.code === 'HTTP_404') return 'Resource not found on provider'
  if (msg.includes('409') || error?.code === 'HTTP_409') return 'Conflict — the SIM may already have the requested package'
  if (msg.includes('422') || error?.code === 'HTTP_422') return 'Invalid package configuration — the package may not be compatible with this SIM'
  if (msg.includes('429') || error?.code === 'HTTP_429') return 'Provider rate limit reached — please wait before retrying'
  if (msg.includes('5') || error?.code?.startsWith('HTTP_5')) return 'Provider server error — try again later'
  if (msg.includes('timeout') || error?.code === 'TIMEOUT') return 'Provider request timed out'
  return `${context}: ${msg}`
}

export async function assignPackageToSim(esimId: string, providerPackageId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const assignStartTime = Date.now()

  try {
    // 1. Load ESIM with purchase and package info
    const esim = await prisma.eSIM.findUnique({
      where: { id: esimId },
      include: {
        purchase: {
          include: {
            package: { select: { id: true, providerId: true, providerName: true } },
          },
        },
      },
    })
    if (!esim) return { error: 'eSIM not found' }
    if (!esim.iccid) return { error: 'eSIM has no ICCID' }

    const providerId = esim.purchase.package.providerId
    if (!providerId) return { error: 'eSIM has no linked provider' }

    // 2. Validate ProviderPackage
    const providerPackage = await prisma.providerPackage.findUnique({
      where: { id: providerPackageId },
    })
    if (!providerPackage) return { error: 'Provider package not found' }
    if (providerPackage.providerId !== providerId) return { error: 'Package does not belong to the same provider' }
    if (!providerPackage.isAvailable) return { error: 'Package is not available for assignment' }
    if (providerPackage.providerStatus === 'ARCHIVED') return { error: 'Cannot assign an archived package' }

    // 3. Get connector and provider info
    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) return { error: 'Provider not found' }

    const connector = await buildConnectorFromProvider(providerId)
    if (!connector) return { error: 'Provider not available' }
    if (!isTelnaConnector(connector)) return { error: 'Provider does not support Telna PCR profile management' }

    // 4. Load current PCR profile (before state)
    const currentProfileResult = await connector.getSimPCRProfile(esim.iccid)
    if (!currentProfileResult.success || !currentProfileResult.data) {
      return { error: safeAdminMessage(currentProfileResult.error, 'Failed to load PCR profile') }
    }
    const beforeProfile = mapTelnaPCRProfile(currentProfileResult.data.profile)
    const oldPackageId = beforeProfile.currentPackage.id

    // 5. Apply selected package
    const packageTemplateId = providerPackage.providerPlanCode || providerPackage.providerPlanId
    const updateResult = await connector.updateSimPCRProfile(esim.iccid, {
      package_template_id: packageTemplateId,
    })
    if (!updateResult.success || !updateResult.data) {
      return { error: safeAdminMessage(updateResult.error, 'Package assignment failed') }
    }
    const afterProfile = mapTelnaPCRProfile(updateResult.data.profile)

    // 6. Refresh SIM registry entry
    let simRegistryData: Record<string, unknown> | null = null
    try {
      const simRegistryResult = await connector.getSimRegistry(esim.iccid)
      if (simRegistryResult.success && simRegistryResult.data) {
        const mapped = mapTelnaSimRegistry(simRegistryResult.data.sim)
        simRegistryData = mapped.rawData
      }
    } catch {
      // Non-critical — continue without SIM registry refresh
    }

    // 7. Update local ESIM record
    const updateData: Record<string, unknown> = {
      providerSubscriptionId: afterProfile.currentPackage.id ?? esim.providerSubscriptionId,
      providerStatus: afterProfile.status,
      lastSyncAt: new Date(),
      packageSnapshot: {
        before: beforeProfile,
        after: afterProfile,
        assignedPackage: { id: providerPackage.id, name: providerPackage.name, planId: providerPackage.providerPlanId },
      },
      packageName: afterProfile.currentPackage.name || providerPackage.name,
    }
    if (afterProfile.expiration.expirationDate) {
      updateData.expiresAt = new Date(afterProfile.expiration.expirationDate)
    }
    await prisma.eSIM.update({
      where: { id: esimId },
      data: updateData as any,
    })

    const durationMs = Date.now() - assignStartTime

    // 8. Audit log
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'PACKAGE_ASSIGN',
        entity: 'ESIM',
        entityId: esimId,
        details: JSON.stringify({
          iccid: esim.iccid,
          provider: provider.code || provider.name,
          oldPackage: oldPackageId,
          newPackage: packageTemplateId,
          durationMs,
        }),
      },
    })

    // 9. Emit events
    const { emitEvent } = await import('@/lib/catalog-events')
    const eventType = oldPackageId && oldPackageId !== String(packageTemplateId) ? 'SIM_PACKAGE_CHANGED' : 'SIM_PACKAGE_ASSIGNED'
    emitEvent({
      eventType: eventType as any,
      providerId,
      providerCode: provider.code,
      packageId: providerPackage.id,
      comparableKey: null,
      changedFields: ['package'],
      trigger: 'USER_ACTION',
      userId: session.user.id,
      metadata: {
        iccid: esim.iccid,
        oldPackage: oldPackageId,
        newPackage: packageTemplateId,
        esimId,
        durationMs,
      },
    })

    // Log diagnostics
    console.log(`[TELNA_PACKAGE_ASSIGN] iccid=${esim.iccid} status=success package=${packageTemplateId} oldPackage=${oldPackageId} durationMs=${durationMs}`)

    revalidatePath(`/admin/esims/${esimId}`)
    revalidatePath('/admin/esims')

    return {
      success: true,
      data: {
        iccid: esim.iccid,
        oldPackage: oldPackageId,
        newPackage: packageTemplateId,
        status: afterProfile.status,
        durationMs,
      },
    }
  } catch (error: any) {
    const durationMs = Date.now() - assignStartTime
    console.error(`[TELNA_PACKAGE_ASSIGN] esimId=${esimId} error=${error?.message || 'Unknown'} durationMs=${durationMs}`)
    return { error: safeAdminMessage(error, 'Package assignment failed') }
  }
}

export async function refreshSimPCRProfile(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  try {
    const esim = await prisma.eSIM.findUnique({
      where: { id: esimId },
      include: { purchase: { include: { package: { select: { providerId: true } } } } },
    })
    if (!esim) return { error: 'eSIM not found' }
    if (!esim.iccid) return { error: 'eSIM has no ICCID' }

    const providerId = esim.purchase.package.providerId
    if (!providerId) return { error: 'No linked provider' }

    const connector = await buildConnectorFromProvider(providerId)
    if (!connector) return { error: 'Provider not available' }
    if (!isTelnaConnector(connector)) return { error: 'Provider does not support Telna PCR profile' }

    const result = await connector.getSimPCRProfile(esim.iccid)
    if (!result.success || !result.data) {
      return { error: safeAdminMessage(result.error, 'Failed to refresh PCR profile') }
    }

    const mapped = mapTelnaPCRProfile(result.data.profile)
    const updateData: Record<string, unknown> = {
      providerStatus: mapped.status,
      lastSyncAt: new Date(),
    }
    if (mapped.expiration.expirationDate) {
      updateData.expiresAt = new Date(mapped.expiration.expirationDate)
    }
    await prisma.eSIM.update({
      where: { id: esimId },
      data: updateData as any,
    })

    const { emitEvent } = await import('@/lib/catalog-events')
    emitEvent({
      eventType: 'SIM_PROFILE_UPDATED' as any,
      providerId,
      providerCode: null,
      packageId: null,
      comparableKey: null,
      changedFields: ['pcr_profile'],
      trigger: 'USER_ACTION',
      userId: session.user.id,
      metadata: { iccid: esim.iccid, esimId },
    })

    revalidatePath(`/admin/esims/${esimId}`)
    revalidatePath('/admin/esims')

    return { success: true, data: mapped }
  } catch (error: any) {
    return { error: safeAdminMessage(error, 'PCR profile refresh failed') }
  }
}
