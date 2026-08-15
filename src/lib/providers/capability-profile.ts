import { prisma } from '@/lib/prisma'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { DEFAULT_CONNECTOR_CAPABILITIES as BASE } from '@/lib/providers/connectors/connector-interface'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'

export type CapabilityStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_IMPLEMENTED'

/**
 * Capability layers (never conflated):
 *  A. Connector capability  — from the connector implementation (runtime truth).
 *  B. Provider DB capability — internal enable flag (e.g. supportsQRCode).
 *  C. Client portal exposure — provider_capability_exposure.clientPortalEnabled.
 *  D. Client API exposure    — provider_capability_exposure.clientApiEnabled.
 */
export interface ProviderCapabilityProfile {
  providerId: string
  connector: { capabilities: ConnectorCapabilities } | null
  configured: {
    supportsQRCode: boolean
    supportsESIM: boolean
    supportsUsage: boolean
    supportsUsageSync: boolean
    supportsTopUp: boolean
    enabledCapabilities: string[]
  }
  exposure: {
    installation: { portal: boolean; api: boolean }
    status: { portal: boolean; api: boolean }
    usage: { portal: boolean; api: boolean }
    topUp: { portal: boolean; api: boolean }
  }
  mismatches: Array<{ capability: string; connector: boolean; dbFlag: string | boolean | null; note: string }>
  matrix: Array<{
    capability: string
    connector: CapabilityStatus
    dbConfigured: boolean
    portalExposure: boolean
    apiExposure: boolean
    mismatch: boolean
  }>
}

const CAP_TO_DB: Record<keyof ConnectorCapabilities, { db: keyof ProviderCapabilityProfile['configured'] }> = {
  installationLookup: { db: 'supportsQRCode' },
  installationDataAtPurchase: { db: 'supportsESIM' },
  installationLookupHistorical: { db: 'supportsQRCode' },
  statusLookup: { db: 'supportsESIM' },
  usageLookup: { db: 'supportsUsage' },
  topUp: { db: 'supportsTopUp' },
  suspend: { db: 'supportsESIM' },
  resume: { db: 'supportsESIM' },
  balance: { db: 'supportsESIM' },
  inventory: { db: 'supportsESIM' },
  webhooks: { db: 'supportsESIM' },
}

export function connectorCapabilityStatus(declared: boolean, methodPresent: boolean, methodName: keyof ConnectorCapabilities): CapabilityStatus {
  if (!declared) return 'NOT_SUPPORTED'
  return methodPresent ? 'SUPPORTED' : 'NOT_IMPLEMENTED'
}

export async function getProviderCapabilityProfile(providerId: string): Promise<ProviderCapabilityProfile> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  const connector = provider ? await buildConnectorFromProvider(provider.id).catch(() => null) : null
  const caps: ConnectorCapabilities = connector?.capabilities ? { ...BASE, ...connector.capabilities } : { ...BASE }

  const configured = {
    supportsQRCode: Boolean(provider?.supportsQRCode),
    supportsESIM: Boolean(provider?.supportsESIM),
    supportsUsage: Boolean(provider?.supportsUsage),
    supportsUsageSync: Boolean(provider?.supportsUsageSync),
    supportsTopUp: Boolean(provider?.supportsTopUp),
    enabledCapabilities: (provider?.enabledCapabilities as string[]) || [],
  }

  const [installPortal, installApi, statusPortal, statusApi, usagePortal, usageApi, topUpPortal, topUpApi] = await Promise.all([
    isCapabilityExposedToPortal(providerId, ProviderCapability.STATUS).catch(() => false),
    isCapabilityExposedToApi(providerId, ProviderCapability.STATUS).catch(() => false),
    isCapabilityExposedToPortal(providerId, ProviderCapability.STATUS).catch(() => false),
    isCapabilityExposedToApi(providerId, ProviderCapability.STATUS).catch(() => false),
    isCapabilityExposedToPortal(providerId, ProviderCapability.USAGE).catch(() => false),
    isCapabilityExposedToApi(providerId, ProviderCapability.USAGE).catch(() => false),
    isCapabilityExposedToPortal(providerId, ProviderCapability.TOP_UP).catch(() => false),
    isCapabilityExposedToApi(providerId, ProviderCapability.TOP_UP).catch(() => false),
  ])

  const exposure = {
    installation: { portal: installPortal, api: installApi },
    status: { portal: statusPortal, api: statusApi },
    usage: { portal: usagePortal, api: usageApi },
    topUp: { portal: topUpPortal, api: topUpApi },
  }

  const matrix: ProviderCapabilityProfile['matrix'] = []
  const mismatches: ProviderCapabilityProfile['mismatches'] = []

  const exposureByCap: Record<keyof ConnectorCapabilities, { portal: boolean; api: boolean }> = {
    installationLookup: { portal: installPortal, api: installApi },
    installationDataAtPurchase: { portal: installPortal, api: installApi },
    installationLookupHistorical: { portal: installPortal, api: installApi },
    statusLookup: { portal: statusPortal, api: statusApi },
    usageLookup: { portal: usagePortal, api: usageApi },
    topUp: { portal: topUpPortal, api: topUpApi },
    suspend: { portal: statusPortal, api: statusApi },
    resume: { portal: statusPortal, api: statusApi },
    balance: { portal: statusPortal, api: statusApi },
    inventory: { portal: statusPortal, api: statusApi },
    webhooks: { portal: statusPortal, api: statusApi },
  }

  for (const [capKey, mapping] of Object.entries(CAP_TO_DB) as Array<[keyof ConnectorCapabilities, { db: keyof ProviderCapabilityProfile['configured'] }]>) {
    const connectorSupported = caps[capKey]
    const dbConfigured = Boolean(configured[mapping.db])
    const connectorStatus: CapabilityStatus = connector
      ? connectorCapabilityStatus(connectorSupported, true, capKey)
      : 'NOT_IMPLEMENTED'
    const exp = exposureByCap[capKey]
    matrix.push({
      capability: capKey,
      connector: connectorStatus,
      dbConfigured,
      portalExposure: exp.portal,
      apiExposure: exp.api,
      mismatch: connectorSupported !== dbConfigured,
    })
    if (connectorSupported !== dbConfigured) {
      mismatches.push({ capability: capKey, connector: connectorSupported, dbFlag: mapping.db, note: `Connector declares ${connectorSupported} but provider DB flag ${String(mapping.db)}=${dbConfigured}` })
    }
  }

  return { providerId, connector: connector ? { capabilities: caps } : null, configured, exposure, mismatches, matrix }
}
