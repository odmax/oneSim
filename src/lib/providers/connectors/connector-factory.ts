import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import type { IProviderConnector } from './connector-interface'
import { MockConnector } from './mock-connector'
import { RestCatalogConnector } from './rest-catalog-connector'
import { UrlTokenConnector } from './url-token-connector'
import { HeaderTokenRestConnector } from './header-token-rest-connector'
import { StandardProviderConnector } from './standard-connector'

export type ConnectorType = 'MOCK' | 'REST_CATALOG' | 'URL_TOKEN' | 'HEADER_TOKEN' | 'STANDARD'

export function resolveConnectorType(adapterStrategy: string | null | undefined, providerType: string): ConnectorType {
  if (providerType === 'MOCK') return 'MOCK'
  switch (adapterStrategy) {
    case 'STANDARD': return 'STANDARD'
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
        tokenPlacement: config.tokenPlacement || undefined,
        authType: config.authType || undefined,
      })
    case 'URL_TOKEN':
      return new UrlTokenConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
    case 'HEADER_TOKEN':
      return new HeaderTokenRestConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
    case 'REST_CATALOG':
    default:
      return new RestCatalogConnector(providerId, name, { apiBaseUrl: baseUrl, apiToken: token, authUrl, environment: env })
  }
}

export async function buildConnectorFromProvider(providerId: string): Promise<IProviderConnector | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return null

  const connectorType = resolveConnectorType(provider.adapterStrategy, provider.type)
  return createConnector(provider.id, provider.name, connectorType, {
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
    fieldMappings: provider.fieldMappings,
    endpointMappings: provider.endpointMappings,
    tokenPlacement: provider.tokenPlacement,
    authType: provider.authType,
  })
}
