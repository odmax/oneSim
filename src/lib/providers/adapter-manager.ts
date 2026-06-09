import { prisma } from '@/lib/prisma'
import type { ProviderAdapter, CredentialField, ProviderCapability } from './adapter-types'
import { GenericProtocolAdapter } from './generic-protocol-adapter'
import { TemplateProviderAdapter } from './template-provider-adapter'
import { registry } from '@/services/providerRegistry'
import { buildConnectorFromProvider } from './connectors/connector-factory'
import { decryptToken } from '@/lib/encryption'
import type { IProviderConnector } from './connectors/connector-interface'

export function isProviderOperational(status: string): boolean {
  return status === 'ACTIVE' || status === 'DEGRADED' || status === 'TESTING'
}

function connectorToAdapter(connector: IProviderConnector): ProviderAdapter {
  return {
    providerId: connector.providerId,
    name: connector.name,
    authenticate: async (credentials) => {
      const r = await connector.authenticate(credentials)
      if (!r.success) return { success: false, error: { code: r.error?.code || 'AUTH_FAILED', message: r.error?.message || 'Authentication failed' } }
      return { success: true, data: { token: r.data?.token || '', accountInfo: r.data?.accountInfo } }
    },
    getCredentialFields: () => [],
    getCapabilities: () => [],
    testConnection: async () => {
      const r = await connector.testConnection()
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    syncPlans: async () => {
      const r = await connector.syncPlans()
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    activateESIM: async (params) => {
      const r = await connector.activateESIM(params)
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    getActivationStatus: async (id) => {
      const r = await connector.getStatus(id)
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: { status: r.data?.status || 'UNKNOWN', iccids: r.data?.iccids } }
    },
    suspendESIM: async (id) => {
      const r = await connector.suspendESIM(id)
      if (!r.success) return { success: false, error: r.error }
      return { success: true }
    },
    resumeESIM: async (id) => {
      const r = await connector.resumeESIM(id)
      if (!r.success) return { success: false, error: r.error }
      return { success: true }
    },
    getUsage: async (iccid) => {
      const r = await connector.getUsage(iccid)
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    getRates: async () => {
      const r = await connector.getRates()
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    getQRCode: async (iccid) => {
      const r = await connector.getQRCode(iccid)
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    topUpESIM: async (params) => {
      const r = await connector.topUpESIM(params)
      if (!r.success) return { success: false, error: r.error }
      return { success: true, data: r.data }
    },
    handleWebhook: async () => ({ success: true, data: { handled: true, action: 'acknowledged' } }),
  }
}

export async function getAdapterForProvider(providerId: string): Promise<ProviderAdapter | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider || !isProviderOperational(provider.status)) return null
  return await buildAdapter(provider)
}

export async function getAdapterForType(type: string, config?: { apiBaseUrl?: string | null; apiToken?: string | null; providerId?: string; environment?: string | null; authUrl?: string | null }): Promise<ProviderAdapter> {
  const providerId = config?.providerId

  // Try connector system first when a real provider ID is available
  if (providerId && providerId !== 'auth' && providerId !== 'undefined') {
    try {
      const connector = await buildConnectorFromProvider(providerId)
      if (connector) return connectorToAdapter(connector)
    } catch {
      // Connector failed — fall through to GenericProtocolAdapter
    }
  }

  const id = providerId || `builtin-${type.toLowerCase()}`

  return new GenericProtocolAdapter({
    id,
    type,
    apiBaseUrl: config?.apiBaseUrl || undefined,
    authUrl: config?.authUrl || undefined,
    apiToken: decryptToken(config?.apiToken) || undefined,
    environment: config?.environment || undefined,
  })
}

export async function buildAdapter(provider: {
  id: string
  name?: string
  code?: string
  type: string
  adapterStrategy?: string | null
  apiBaseUrl?: string | null
  authUrl?: string | null
  apiToken?: string | null
  tokenPlacement?: string | null
  planListPath?: string | null
  activationPath?: string | null
  statusPath?: string | null
  usagePath?: string | null
  suspendPath?: string | null
  resumePath?: string | null
  responseListKey?: string | null
  fieldMappings?: any
  authType?: string | null
  config?: any
  endpointMappings?: any
  environment?: string | null
}): Promise<ProviderAdapter | null> {
  // Try new connector system first
  const connector = await buildConnectorFromProvider(provider.id)
  if (connector) return connectorToAdapter(connector)

  // Check if provider is template-driven (has endpointMappings)
  const hasEndpointMappings = provider.endpointMappings && typeof provider.endpointMappings === 'object' && Object.keys(provider.endpointMappings).length > 0
  if (hasEndpointMappings) {
    console.log(`[buildAdapter] Using TemplateProviderAdapter for ${provider.name} (${provider.id})`)
    return new TemplateProviderAdapter(provider)
  }

  const strategy = provider.adapterStrategy || ''

  if (strategy === 'REST_CATALOG') {
    return new GenericProtocolAdapter(provider)
  }

  // Try registry by slug (provider.code as slug)
  if (provider.code) {
    try {
      const regAdapter = await registry.resolve(provider.code.toLowerCase())
      return regAdapter as unknown as ProviderAdapter
    } catch {
      // Not in registry, continue to generic fallback
    }
  }

  // Generic fallback
  return new GenericProtocolAdapter(provider)
}

export function getAdapterCapabilities(adapter: ProviderAdapter): ProviderCapability[] {
  return adapter.getCapabilities()
}

export function getAdapterCredentialFields(type: string, authUrl?: string | null): CredentialField[] {
  if (authUrl) {
    return [
      { name: 'username', label: 'Username / Email', type: 'text', required: true, placeholder: 'API username' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'API password' },
      { name: 'environment', label: 'Environment', type: 'select', required: false, placeholder: 'Select environment', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
    ]
  }
  return [
    { name: 'apiToken', label: 'API Token / Secret', type: 'password', required: false, placeholder: 'Provider API token' },
    { name: 'apiBaseUrl', label: 'API Base URL', type: 'text', required: false, placeholder: 'https://api.example.com' },
  ]
}

export async function authenticateProviderViaAdapter(
  type: string,
  credentials: Record<string, string>,
  config?: { apiBaseUrl?: string | null; apiToken?: string | null; providerId?: string }
): Promise<{ success: boolean; token?: string; accountInfo?: any; error?: string; code?: string }> {
  try {
    const adapter = await getAdapterForType(type, { ...config, providerId: config?.providerId || 'auth' })
    const result = await adapter.authenticate(credentials)

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Authentication failed', code: result.error?.code }
    }

    return {
      success: true,
      token: result.data?.token,
      accountInfo: result.data?.accountInfo,
    }
  } catch (e: any) {
    return { success: false, error: e.message || 'Authentication threw an error', code: 'ADAPTER_ERROR' }
  }
}
