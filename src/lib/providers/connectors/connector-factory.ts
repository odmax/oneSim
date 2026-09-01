import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import type { IProviderConnector } from './connector-interface'
import { AirHubConnector } from './airhub-connector'
import { MockConnector } from './mock-connector'
import { RestCatalogConnector } from './rest-catalog-connector'
import { UrlTokenConnector } from './url-token-connector'
import { HeaderTokenRestConnector } from './header-token-rest-connector'
import { StandardProviderConnector } from './standard-connector'
import { TelnaConnector } from './telna-connector'
import { TelnaFlexConnector } from './telna-flex-connector'
import { TelnaSeamlessConnector } from './telna-seamless-connector'
import { IbasisConnector } from './ibasis-connector'
import { UsMatrixConnector } from './usmatrix-connector'
import { resolveConnectorType } from './connector-type'
import type { ConnectorType as ConnectorTypeAlias } from './connector-type'
import { normalizeChoiceUserId } from './url-token-connector'

export { resolveConnectorType } from './connector-type'
export type { ConnectorType } from './connector-type'

type ConnectorFactoryConfig = Parameters<typeof createConnector>[3]
export type ConnectorOverrideFactory = (providerId: string, name: string | undefined, config: ConnectorFactoryConfig) => IProviderConnector

/**
 * TEST/LOAD-HARNESS ONLY — connector override registry, EMPTY and useless in
 * normal execution. Registration and lookup FAIL CLOSED unless BOTH:
 *   A. an explicit load-harness mode is enabled (LOAD_HARNESS=1), AND
 *   B. DATABASE_URL names a database beginning with `onesim_load_`.
 * Application runtime never satisfies both, so normal development/staging/
 * production connector resolution is behaviorally identical (registry never
 * read when the gate fails). There is NO generic production feature flag.
 */
export const CONNECTOR_OPERATION_OVERRIDES: Record<string, ConnectorOverrideFactory> = {}

export function databaseNameFromUrl(url: string | undefined): string {
  if (!url) return ''
  const m = /^(?:postgres(?:ql)?:\/\/)?[^@/]+@[^:/?]+:\d+\/([^?]+)/.exec(url)
  return m ? decodeURIComponent(m[1]) : ''
}

function hostFromUrl(url: string | undefined): string {
  if (!url) return ''
  const m = /^(?:postgres(?:ql)?:\/\/)?[^@/]+@([^:/?]+):/.exec(url)
  return m ? m[1] : ''
}

export function loadHarnessModeEnabled(): boolean {
  return process.env.LOAD_HARNESS === '1'
}

export function loadOverrideGate(): { ok: boolean; reason?: string } {
  if (!loadHarnessModeEnabled()) return { ok: false, reason: 'LOAD_HARNESS mode not enabled' }
  const db = databaseNameFromUrl(process.env.DATABASE_URL)
  if (!db.startsWith('onesim_load_')) return { ok: false, reason: `DATABASE_URL must name a onesim_load_* database (got ${db || '(none)'})` }
  const low = hostFromUrl(process.env.DATABASE_URL).toLowerCase()
  if (low.includes('staging')) return { ok: false, reason: 'staging-like host rejected' }
  if ((low.includes('prod') || low.includes('production')) && !low.includes('staging')) return { ok: false, reason: 'production-like host rejected' }
  return { ok: true }
}

function readConnectorOverride(connectorType: string): { gateOk: boolean; factory?: ConnectorOverrideFactory } {
  const gate = loadOverrideGate()
  if (!gate.ok) return { gateOk: false }
  return { gateOk: true, factory: CONNECTOR_OPERATION_OVERRIDES[connectorType] }
}

/**
 * Register a fake-connector override. Throws before ANY provider operation if
 * the load environment gate is not satisfied (never silently ignored).
 */
export function registerConnectorOverride(connectorType: string, factory: ConnectorOverrideFactory): void {
  const gate = loadOverrideGate()
  if (!gate.ok) throw new Error(`CONNECTOR_OVERRIDE_BLOCKED: ${gate.reason}`)
  CONNECTOR_OPERATION_OVERRIDES[connectorType] = factory
}

export function createConnector(providerId: string, name: string | undefined, connectorType: ConnectorTypeAlias, config: {
  apiBaseUrl?: string | null
  apiToken?: string | null
  authUrl?: string | null
  environment?: string | null
  planListPath?: string | null
  activationPath?: string | null
  statusPath?: string | null
  usagePath?: string | null
  suspendPath?: string | null
  resumePath?: string | null
  responseListKey?: string | null
  fieldMappings?: any
  endpointMappings?: any
  requestMappings?: Record<string, any>
  config?: any
  tokenPlacement?: string | null
  authType?: string | null
}): IProviderConnector {
  // TEST/LOAD-HARNESS ONLY seam — read-only here, gated fail-closed by
  // `readConnectorOverride`:
  //   gate FAILS (normal dev/staging/prod)        → registry never consulted,
  //                                                  canonical resolution unchanged.
  //   gate PASSES + override exists               → fake override returned.
  //   gate PASSES + override missing (load mode)  → THROW — a permanent load
  //                                                  harness must never fall
  //                                                  through to a canonical
  //                                                  connector it did not fake.
  const override = readConnectorOverride(connectorType)
  if (override.gateOk) {
    if (override.factory) return override.factory(providerId, name, config)
    throw new Error(`LOAD_HARNESS_CONNECTOR_OVERRIDE_MISSING: no fake connector override registered for '${connectorType}' in load mode`)
  }

  const baseUrl = config.apiBaseUrl || ''
  const token = config.apiToken || undefined
  const authUrl = config.authUrl || undefined
  const env = config.environment || undefined

  switch (connectorType) {
    case 'MOCK': {
      // Production guard: the mock connector fabricates successful activations
      // with dummy ICCIDs and zero network. It must never fulfill real paid
      // orders unless explicitly allowed.
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MOCK_PROVIDERS !== 'true') {
        throw new Error('MOCK connector is not allowed in production (set ALLOW_MOCK_PROVIDERS=true to override)')
      }
      return new MockConnector(providerId, name)
    }
    case 'AIRHUB':
      return new AirHubConnector(providerId)
    case 'TELNA_SEAMLESS':
      return new TelnaSeamlessConnector(providerId)
    case 'STANDARD':
      return new StandardProviderConnector({
        providerId, name,
        apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env,
        planListPath: config.planListPath || undefined,
        activationPath: config.activationPath || undefined,
        statusPath: config.statusPath || undefined,
        usagePath: config.usagePath || undefined,
        suspendPath: config.suspendPath || undefined,
        resumePath: config.resumePath || undefined,
        responseListKey: config.responseListKey || undefined,
        fieldMappings: config.fieldMappings || undefined,
        endpointMappings: config.endpointMappings || undefined,
        requestMappings: config.requestMappings,
        config: config.config,
        tokenPlacement: config.tokenPlacement || undefined,
        authType: config.authType || undefined,
      })
    case 'URL_TOKEN':
      return new UrlTokenConnector(providerId, name, {
        apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env,
        fieldMappings: config.fieldMappings,
        balancePath: config.config?.balancePath,
        packageDetailPath: config.config?.packageDetailPath,
        suspendPath: config.suspendPath || undefined,
        resumePath: config.resumePath || undefined,
        currency: config.config?.currency,
        timeoutMs: config.config?.timeoutMs,
      })
    case 'HEADER_TOKEN':
      return new HeaderTokenRestConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
    case 'TELNA':
      return new TelnaConnector(providerId, name)
    case 'TELNA_FLEX':
      return new TelnaFlexConnector(providerId, name)
    case 'IBASIS':
      return new IbasisConnector(providerId)
    case 'USMATRIX':
      return new UsMatrixConnector(providerId, name)
    case 'REST_CATALOG':
    default:
      return new RestCatalogConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
  }
}

export async function buildConnectorFromProvider(providerId: string): Promise<IProviderConnector | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return null

  const connectorType = resolveConnectorType(provider.adapterStrategy, provider.type, provider.code)
  console.log(`[TRACE_SYNC] step=buildConnectorFromProvider code=${provider.code} strategy=${provider.adapterStrategy} type=${provider.type} resolvedConnector=${connectorType}`)
  console.log(`[buildConnector] provider=${provider.name}(${provider.id}) type=${provider.type} strategy=${provider.adapterStrategy} connectorType=${connectorType}`)

  // Merge fieldMappings from provider.fieldMappings and provider.config?.fieldMappings
  const directFm = typeof provider.fieldMappings === 'object' && provider.fieldMappings !== null
    ? provider.fieldMappings as Record<string, any>
    : {}
  const configFm = typeof provider.config === 'object' && provider.config !== null
    ? (provider.config as any).fieldMappings || {}
    : {}
  const mergedFieldMappings = { ...configFm, ...directFm }

  // Choice defaults: activationPayloadType + userId from config or auth data.
  // A legacy/placeholder fieldMappings.userId (e.g. 'onesim') is NEVER treated
  // as a valid explicit override — it falls through to the authenticated
  // provider.config.userId / selectedAccountId, else '' (purchase validation
  // then fails safely).
  if (provider.adapterStrategy === 'CHOICE' && !mergedFieldMappings.activationPayloadType) {
    mergedFieldMappings.activationPayloadType = 'CHOICE_ADD_BUNDLE_FROM_POOL'
  }
  if (provider.adapterStrategy === 'CHOICE') {
    const cfg = (provider.config as any) || {}
    const fieldUserId = normalizeChoiceUserId(mergedFieldMappings.userId)
    const configUserId = normalizeChoiceUserId(cfg.userId)
    const selectedAccountId = normalizeChoiceUserId(cfg.selectedAccountId)
    mergedFieldMappings.userId = fieldUserId || configUserId || selectedAccountId || ''
  }

  console.log(`[buildConnector] fieldMappings keys: ${Object.keys(mergedFieldMappings).join(', ') || '(none)'}`)
  if (mergedFieldMappings.activationPayloadType) {
    console.log(`[buildConnector] activationPayloadType=${mergedFieldMappings.activationPayloadType} userId=${mergedFieldMappings.userId || '(not set)'}`)
  }

  const result = createConnector(provider.id, provider.name, connectorType, {
    apiBaseUrl: provider.apiBaseUrl,
    apiToken: decryptToken(provider.apiToken),
    authUrl: provider.authUrl,
    environment: provider.environment,
    planListPath: provider.planListPath,
    activationPath: provider.activationPath,
    statusPath: provider.statusPath,
    usagePath: provider.usagePath,
    suspendPath: provider.suspendPath,
    resumePath: provider.resumePath,
    responseListKey: provider.responseListKey,
    fieldMappings: mergedFieldMappings,
    endpointMappings: provider.endpointMappings,
    requestMappings: provider.requestMappings as Record<string, any> | undefined,
    config: provider.config as any,
    tokenPlacement: provider.tokenPlacement,
    authType: provider.authType,
  })

  console.log(`[CONNECTOR_CONFIG] code=${provider.code} hasConfig=${!!provider.config} configKeys=${Object.keys(provider.config || {}).join(',')} partnerCode=${(provider.config as any)?.partnerCode}`)
  return result
}

export async function getStoredCredentials(providerId: string): Promise<{ username: string; password: string } | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { config: true },
  })
  if (!provider) return null
  const cfg = (provider.config as any) || {}
  const username = cfg.username
  const password = cfg.password
  if (!username || !password) return null
  return { username, password }
}
