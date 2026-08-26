/**
 * Canonical QR code / installation-data refresh service.
 *
 * Read-only: never purchases, never mutates wallet/orders, never creates eSIMs.
 * Provider-safe: resolves provider from eSIM → purchase → package chain.
 * Tenant-safe: caller must supply businessId; eSIM must belong to business.
 * Idempotent: re-refreshing the same QR returns the same (or updated) data.
 *
 * Composes the existing canonical services:
 *   - lookupEsimInstallationData()  (provider resolution + connector call)
 *   - persistInstallationLookup()   (safe merge + persist)
 *   - getQrCode() fallback connector method
 */

import { prisma } from '@/lib/prisma'
import { buildInstallationPresentation, normalizeConnectorInstallData, hasUsableInstallData } from '@/lib/esim/installation-data'
import { auditLog } from '@/lib/security/audit'

export type RefreshQrOutcome =
  | 'REFRESHED'
  | 'NO_DATA'
  | 'NOT_SUPPORTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INTERNAL_ERROR'

export interface RefreshQrResult {
  success: boolean
  outcome: RefreshQrOutcome
  error?: string
  esim?: {
    id: string
    iccid: string
    status: string
    activationCode?: string | null
    qrCodeUrl?: string | null
    qrCode?: string | null
    smdpAddress?: string | null
    matchingId?: string | null
    installation?: {
      kind: string
      qrImageUrl?: string | null
      qrPayload?: string | null
      activationCode?: string | null
      smdpAddress?: string | null
      matchingId?: string | null
    }
    qrRefreshedAt?: string
  }
}

export async function refreshEsimQrCode({
  esimId,
  businessId,
  requestedBy,
}: {
  esimId: string
  businessId: string
  requestedBy?: string
}): Promise<RefreshQrResult> {
  const startedAt = Date.now()

  // 1. Load the eSIM scoped to the owning business.
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: {
        select: {
          businessId: true,
          providerId: true,
          package: {
            select: {
              id: true,
              name: true,
              providerPackageId: true,
              providerId: true,
              providerPlanId: true,
            },
          },
        },
      },
    },
  })

  if (!esim) {
    return { success: false, outcome: 'NOT_FOUND', error: 'eSIM not found' }
  }

  // 2. Reject cross-tenant access.
  if (esim.purchase.businessId !== businessId) {
    return { success: false, outcome: 'FORBIDDEN', error: 'eSIM does not belong to this business' }
  }

  // 3. Resolve authoritative provider — never accept from client.
  //
  //    Precedence:
  //      a) ESIMPurchase.providerId — fulfillment evidence stamped at dispatch
  //         time by completeProviderFinalization(). This is the provider that
  //         actually owns/provisioned the eSIM.
  //      b) Authoritative ProviderPackage binding via resolvePackageBacking()
  //         — only BOUND resolutions (providerPackageId → ProviderPackage) are
  //         trusted.  Generic package.providerId fallback is rejected because it
  //         may be a stale default that diverges from the actual fulfilling
  //         provider after failover.
  //      c) If neither resolves → fail closed (QR_PROVIDER_UNRESOLVED).
  let providerId: string | undefined

  const purchaseProviderId = esim.purchase?.providerId
  if (purchaseProviderId) {
    providerId = purchaseProviderId
  } else if (esim.purchase?.package) {
    const { resolvePackageBacking } = await import('@/lib/services/orders/package-backing-resolver')
    const backing = await resolvePackageBacking(esim.purchase.package)

    if (backing.kind === 'BOUND') {
      providerId = backing.backing.providerId
    }
    // BOUND = providerPackageId resolved to an authoritative ProviderPackage.
    // NONE/UNAVAILABLE/CUSTOM = no single trustworthy provider → fail closed.
  }

  if (!providerId) {
    return { success: false, outcome: 'PROVIDER_UNAVAILABLE', error: 'QR_PROVIDER_UNRESOLVED' }
  }

  // 4. Check provider exists and is operational.
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, status: true },
  })
  if (!provider) {
    return { success: false, outcome: 'PROVIDER_UNAVAILABLE', error: 'QR_PROVIDER_UNRESOLVED' }
  }

  const providerStatus = (provider.status || '').toUpperCase()
  if (providerStatus === 'SUSPENDED' || providerStatus === 'DISABLED' || providerStatus === 'DECOMMISSIONED') {
    return { success: false, outcome: 'PROVIDER_UNAVAILABLE', error: 'Provider is not available' }
  }

  // 5. Build connector using canonical factory — never accept from client.
  const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
  const connector = await buildConnectorFromProvider(providerId).catch(() => null)
  if (!connector) {
    return { success: false, outcome: 'PROVIDER_UNAVAILABLE', error: 'Provider not available' }
  }

  // 6. Try canonical lookupInstallationData first (preferred path).
  let installData: { activationCode?: string; qrCodeUrl?: string; qrCode?: string; smdpAddress?: string; matchingId?: string } | null = null
  let lookupState: string | undefined
  let lookupErrorCode: string | undefined
  let qrCodeNotSupported = false

  if (connector.lookupInstallationData && connector.capabilities?.installationLookup === true) {
    const { buildInstallationLookupInput, hasAnyLookupIdentifier } = await import('@/lib/providers/installation-lookup')
    const input = buildInstallationLookupInput(esim)

    if (hasAnyLookupIdentifier(input)) {
      const started = Date.now()
      const lookupResult = await connector.lookupInstallationData(input)
      const durationMs = Date.now() - started

      lookupState = lookupResult.state
      lookupErrorCode = lookupResult.errorCode

      if (lookupResult.success && lookupResult.data) {
        installData = normalizeConnectorInstallData(lookupResult.data)
      }

      await logQrRefresh(esimId, businessId, providerId, 'lookupInstallationData', lookupResult.state, lookupResult.errorCode, durationMs)
    }
  }

  // 7. Fallback: try legacy getQRCode if lookupInstallationData didn't produce data.
  if (!installData && lookupState !== 'NOT_SUPPORTED' && lookupState !== 'PERMANENT_FAILURE') {
    const qrResult = await connector.getQRCode(esim.iccid).catch(() => null)

    if (qrResult?.success && qrResult.data) {
      installData = normalizeConnectorInstallData(qrResult.data)
      await logQrRefresh(esimId, businessId, providerId, 'getQRCode', 'HAS_DATA', undefined, Date.now() - startedAt)
    } else {
      const errorCode = qrResult?.error?.code
      if (errorCode === 'NOT_SUPPORTED' || errorCode === 'NOT_IMPLEMENTED') {
        qrCodeNotSupported = true
      }
      await logQrRefresh(esimId, businessId, providerId, 'getQRCode', qrResult?.success ? 'NO_DATA' : 'FAILED', errorCode, Date.now() - startedAt)
    }
  }

  // 8. Map outcome from lookup state / error codes.
  if (lookupState === 'NOT_SUPPORTED' || lookupErrorCode === 'LOOKUP_NOT_SUPPORTED' || qrCodeNotSupported) {
    return { success: false, outcome: 'NOT_SUPPORTED', error: 'QR_REFRESH_NOT_SUPPORTED' }
  }

  if (!installData || (!installData.activationCode && !installData.qrCodeUrl && !installData.qrCode && !installData.smdpAddress && !installData.matchingId)) {
    const msg = lookupState === 'NOT_AVAILABLE_YET'
      ? 'QR code is not available yet. Try again shortly.'
      : 'QR_NOT_AVAILABLE'
    return { success: false, outcome: 'NO_DATA', error: msg }
  }

  // 9. Validate returned values before writing.
  if (installData.activationCode && typeof installData.activationCode !== 'string') {
    return { success: false, outcome: 'INTERNAL_ERROR', error: 'Invalid activation code from provider' }
  }
  if (installData.qrCodeUrl && typeof installData.qrCodeUrl !== 'string') {
    return { success: false, outcome: 'INTERNAL_ERROR', error: 'Invalid QR code URL from provider' }
  }

  // 10. Persist only installation-related fields — merge with existing data.
  //
  //     A refresh may replace a field ONLY when the provider returned a valid,
  //     non-empty value.  null / undefined / empty / whitespace-only strings
  //     must never erase existing usable installation data.
  const safe = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined

  const newAc = safe(installData.activationCode)
  const newQrUrl = safe(installData.qrCodeUrl)
  const newQr = safe(installData.qrCode)
  const newSmdp = safe(installData.smdpAddress)
  const newMatch = safe(installData.matchingId)

  const updateData: Record<string, any> = {
    installationLastCheckedAt: new Date(),
    installationLastError: null,
  }
  if (newAc) updateData.activationCode = newAc
  if (newQrUrl) updateData.qrCodeUrl = newQrUrl
  if (newQr) updateData.qrCode = newQr
  if (newSmdp) updateData.smdpAddress = newSmdp
  if (newMatch) updateData.matchingId = newMatch

  await prisma.eSIM.update({ where: { id: esimId }, data: updateData })

  // Effective install fields = provider data (fresh) merged with existing (fallback).
  const effectiveInstallFields = {
    activationCode: newAc || esim.activationCode || undefined,
    qrCodeUrl: newQrUrl || esim.qrCodeUrl || undefined,
    qrCode: newQr || esim.qrCode || undefined,
    smdpAddress: newSmdp || esim.smdpAddress || undefined,
    matchingId: newMatch || esim.matchingId || undefined,
  }

  const installationStatus = hasUsableInstallData(effectiveInstallFields) ? 'READY' : 'PENDING'

  await prisma.eSIM.update({
    where: { id: esimId },
    data: { installationStatus },
  })

  // 11. Audit — safe fields only.
  const durationMs = Date.now() - startedAt
  await auditLog({
    action: 'QR_REFRESH_SUCCEEDED',
    entity: 'ESIM',
    entityId: esimId,
    details: JSON.stringify({ businessId, providerId: providerId.slice(0, 8) + '…', durationMs }),
  }).catch(() => {})

  // 12. Return normalized public installation DTO — no provider identity or raw data.
  const install = buildInstallationPresentation(effectiveInstallFields)

  return {
    success: true,
    outcome: 'REFRESHED',
    esim: {
      id: esim.id,
      iccid: esim.iccid,
      status: esim.status,
      activationCode: install.activationCode || null,
      qrCodeUrl: install.qrImageUrl || null,
      qrCode: install.qrPayload || null,
      smdpAddress: install.smdpAddress || null,
      matchingId: install.matchingId || null,
      installation: {
        kind: install.kind,
        qrImageUrl: install.qrImageUrl || null,
        qrPayload: install.qrPayload || null,
        activationCode: install.activationCode || null,
        smdpAddress: install.smdpAddress || null,
        matchingId: install.matchingId || null,
      },
      qrRefreshedAt: new Date().toISOString(),
    },
  }
}

async function logQrRefresh(
  esimId: string,
  businessId: string,
  providerId: string,
  method: string,
  state: string,
  errorCode: string | undefined,
  durationMs: number,
): Promise<void> {
  console.log(
    `[QR_REFRESH] esimId=${esimId} businessId=${businessId.slice(0, 8)}… providerId=${providerId.slice(0, 8)}… method=${method} state=${state} errorCode=${errorCode || 'none'} durationMs=${durationMs}`,
  )
}
