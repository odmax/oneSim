import { prisma } from '@/lib/prisma'
import type { ProviderInstallData } from '@/lib/esim/installation-data'
import { hasUsableInstallData, mergeInstallData } from '@/lib/esim/installation-data'
import type { IProviderConnector, InstallationLookupResult, InstallationLookupInput } from '@/lib/providers/connectors/connector-interface'

export type { InstallationLookupResult, InstallationLookupInput, InstallationLookupState } from '@/lib/providers/connectors/connector-interface'

export const INSTALLATION_LOOKUP_ERROR_CODES = {
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  IDENTIFIER_MISSING: 'IDENTIFIER_MISSING',
  LOOKUP_NOT_SUPPORTED: 'LOOKUP_NOT_SUPPORTED',
  NO_INSTALL_DATA: 'NO_INSTALL_DATA',
  NO_QR_CODE: 'NO_QR_CODE',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_HTTP_ERROR: 'PROVIDER_HTTP_ERROR',
  PROVIDER_RESPONSE_UNMAPPED: 'PROVIDER_RESPONSE_UNMAPPED',
} as const

export function maskEsimIdentifier(esim: InstallationLookupInput): string {
  if (esim.iccid) return esim.iccid.length <= 8 ? '****' : `${esim.iccid.slice(0, 4)}••••${esim.iccid.slice(-4)}`
  if (esim.imsi) return esim.imsi.length <= 8 ? '****' : `${esim.imsi.slice(0, 3)}••••${esim.imsi.slice(-3)}`
  if (esim.providerSubscriptionId) return 'sub-****'
  if (esim.providerActivationId) return 'act-****'
  return ''
}

export function identifierTypeOf(esim: InstallationLookupInput): string {
  if (esim.iccid) return 'iccid'
  if (esim.imsi) return 'imsi'
  if (esim.imsiVersion != null) return 'imsi_version'
  if (esim.providerSubscriptionId) return 'provider_subscription_id'
  if (esim.providerActivationId) return 'provider_activation_id'
  return 'none'
}

/** True when the eSIM carries any usable provider identifier for a lookup. */
export function hasAnyLookupIdentifier(esim: InstallationLookupInput): boolean {
  return Boolean(esim.iccid || esim.imsi || esim.imsiVersion != null || esim.providerSubscriptionId || esim.providerActivationId)
}

/**
 * Build a canonical, SAFE provider identifier for an eSIM across all operations
 * (STATUS / USAGE / INSTALLATION / TOP_UP / SUSPEND / RESUME). Provider-owned
 * references and ICCID/IMSI/imsi_version only — a local OneSIM id is NEVER used
 * as a provider identifier. Connectors decide which fields they require and fail
 * locally with IDENTIFIER_MISSING when a required one is absent.
 */
export function resolveProviderEsimIdentifier(esim: {
  iccid?: string | null
  imsi?: string | null
  imsiVersion?: string | number | null
  providerSubscriptionId?: string | null
  providerActivationId?: string | null
}): { iccid?: string; imsi?: string; imsiVersion?: string | number; providerSubscriptionId?: string; providerActivationId?: string } {
  const out: { iccid?: string; imsi?: string; imsiVersion?: string | number; providerSubscriptionId?: string; providerActivationId?: string } = {}
  if (esim.iccid) out.iccid = esim.iccid
  if (esim.imsi) out.imsi = esim.imsi
  if (esim.imsiVersion != null) out.imsiVersion = esim.imsiVersion
  if (esim.providerSubscriptionId) out.providerSubscriptionId = esim.providerSubscriptionId
  if (esim.providerActivationId) out.providerActivationId = esim.providerActivationId
  return out
}

export function buildInstallationLookupInput(esim: {
  id?: string
  iccid?: string | null
  imsi?: string | null
  imsiVersion?: string | number | null
  providerSubscriptionId?: string | null
  providerActivationId?: string | null
}): InstallationLookupInput {
  return { esimId: esim.id ?? undefined, ...resolveProviderEsimIdentifier(esim) }
}

/**
 * CANONICAL installation-lookup service. Used by installation reconciliation,
 * admin manual retry, repair scripts, and any future install-refresh API —
 * never duplicated.
 *
 * Flow: load eSIM → resolve provider via purchase.package.providerId → build
 * connector → build canonical identifier → connector lookupInstallationData →
 * normalize → classify state → safe result.
 *
 * Provider-neutral: no provider-name branches. Read-only: never purchases,
 * never mutates wallet/orders, never creates eSIMs.
 */
export async function lookupEsimInstallationData(esimId: string): Promise<InstallationLookupResult & { esimId: string }> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
  })

  if (!esim) {
    return { esimId, success: false, state: 'PERMANENT_FAILURE', errorCode: 'ESIM_NOT_FOUND' }
  }

  const providerId = esim.purchase?.package?.providerId
  if (!providerId) {
    await recordLookupDiagnostic(esimId, { state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_NOT_FOUND' })
    return { esimId, success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_NOT_FOUND' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    await recordLookupDiagnostic(esimId, { state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_NOT_FOUND' })
    return { esimId, success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_NOT_FOUND' }
  }

  const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
  const connector = await buildConnectorFromProvider(provider.id)
  if (!connector) {
    await recordLookupDiagnostic(esimId, { state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED' })
    return { esimId, success: false, state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED' }
  }

  if (!connector.lookupInstallationData) {
    await recordLookupDiagnostic(esimId, { state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED', connector: connector.name })
    return { esimId, success: false, state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED', diagnostics: { methodUsed: undefined, identifierType: undefined } }
  }

  const input = buildInstallationLookupInput(esim)
  if (!hasAnyLookupIdentifier(input)) {
    await recordLookupDiagnostic(esimId, { state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', connector: connector.name })
    return { esimId, success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING' }
  }

  const started = Date.now()
  const result = await connector.lookupInstallationData(input)
  const durationMs = Date.now() - started

  await recordLookupDiagnostic(esimId, {
    state: result.state,
    errorCode: result.errorCode,
    connector: connector.name,
    diagnostics: result.diagnostics,
    hasData: hasUsableInstallData(result.data || null),
    durationMs,
  })

  return { esimId, ...result }
}

export async function recordLookupDiagnostic(
  esimId: string,
  info: {
    state: string
    errorCode?: string
    connector?: string
    diagnostics?: InstallationLookupResult['diagnostics']
    hasData?: boolean
    durationMs?: number
  },
): Promise<void> {
  const safeState = info.state || 'UNKNOWN'
  const d = info.diagnostics || {}
  console.log(`[INSTALLATION_LOOKUP] esimId=${esimId} connector=${info.connector || 'unknown'} methodUsed=${d.methodUsed || 'none'} identifierType=${d.identifierType || 'none'} httpMethod=${d.httpMethod || 'none'} endpointName=${d.endpointName || 'none'} httpStatus=${d.httpStatus ?? 'none'} resultState=${safeState} hasData=${!!info.hasData} errorCode=${info.errorCode || 'none'} durationMs=${info.durationMs ?? 'none'}`)
  if (d.responseKeys && d.responseKeys.length > 0) {
    console.log(`[INSTALLATION_LOOKUP_KEYS] esimId=${esimId} keys=${d.responseKeys.join(',')}`)
  }
  if (d.note) {
    console.log(`[INSTALLATION_LOOKUP_NOTE] esimId=${esimId} note=${d.note.slice(0, 300)}`)
  }
}

/** Apply lookup data onto an eSIM via the canonical fill-only merge; returns the persisted fields. */
export async function persistInstallationLookup(esimId: string, esim: { qrCode?: string | null; qrCodeUrl?: string | null; activationCode?: string | null; smdpAddress?: string | null; matchingId?: string | null }, data: ProviderInstallData): Promise<ProviderInstallData> {
  const merged = mergeInstallData(esim, data)
  const clean: ProviderInstallData = {}
  if (merged.qrCode) clean.qrCode = merged.qrCode
  if (merged.qrCodeUrl) clean.qrCodeUrl = merged.qrCodeUrl
  if (merged.activationCode) clean.activationCode = merged.activationCode
  if (merged.smdpAddress) clean.smdpAddress = merged.smdpAddress
  if (merged.matchingId) clean.matchingId = merged.matchingId
  if (Object.keys(clean).length === 0) return {}
  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      ...(clean.qrCodeUrl != null ? { qrCodeUrl: clean.qrCodeUrl } : {}),
      ...(clean.qrCode != null ? { qrCode: clean.qrCode } : {}),
      ...(clean.activationCode != null ? { activationCode: clean.activationCode } : {}),
      ...(clean.smdpAddress != null ? { smdpAddress: clean.smdpAddress } : {}),
      ...(clean.matchingId != null ? { matchingId: clean.matchingId } : {}),
    },
  })
  return clean
}

/** True when a connector reports installation lookup support. */
export function connectorSupportsInstallationLookup(connector: Pick<IProviderConnector, 'capabilities' | 'lookupInstallationData'>): boolean {
  return Boolean(connector.lookupInstallationData) && Boolean(connector.capabilities?.installationLookup)
}
