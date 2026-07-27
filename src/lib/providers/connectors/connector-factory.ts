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
import { TelnaSeamlessConnector } from './telna-seamless-connector'

export type ConnectorType = 'MOCK' | 'REST_CATALOG' | 'URL_TOKEN' | 'HEADER_TOKEN' | 'STANDARD' | 'AIRHUB' | 'TELNA' | 'TELNA_SEAMLESS'

export function resolveConnectorType(adapterStrategy: string | null | undefined, providerType: string): ConnectorType {
  if (providerType === 'MOCK') return 'MOCK'
  if (adapterStrategy === 'AIRHUB') return 'AIRHUB'
  if (adapterStrategy === 'TELNA_SEAMLESS') return 'TELNA_SEAMLESS'
  if (adapterStrategy === 'TELNA') return 'TELNA'
  switch (adapterStrategy) {
    case 'STANDARD': return 'STANDARD'
    case 'CHOICE': return 'URL_TOKEN'
    case 'URL_TOKEN': return 'URL_TOKEN'
    case 'HEADER_TOKEN': return 'HEADER_TOKEN'
    case 'REST_CATALOG': return 'REST_CATALOG'
    default: return 'REST_CATALOG'
  }
}

export function createConnector(providerId: string, name: string | undefined, connectorType: ConnectorType, config: {
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
  const baseUrl = config.apiBaseUrl || ''
  const token = config.apiToken || undefined
  const authUrl = config.authUrl || undefined
  const env = config.environment || undefined

  switch (connectorType) {
    case 'MOCK':
      return new MockConnector(providerId, name)
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
      return new UrlTokenConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env, fieldMappings: config.fieldMappings })
    case 'HEADER_TOKEN':
      return new HeaderTokenRestConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
    case 'TELNA':
      return new TelnaConnector(providerId, name)
    case 'REST_CATALOG':
    default:
      return new RestCatalogConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
  }
}

export async function buildConnectorFromProvider(providerId: string): Promise<IProviderConnector | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return null

  const connectorType = resolveConnectorType(provider.adapterStrategy, provider.type)
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
