import { prisma } from '@/lib/prisma'
import type { ProviderAdapter, CredentialField, ProviderCapability } from './adapter-types'
import { GenericProtocolAdapter } from './generic-protocol-adapter'
import { TemplateProviderAdapter } from './template-provider-adapter'
import { registry } from '@/services/providerRegistry'
import { buildConnectorFromProvider } from './connectors/connector-factory'
import { decryptToken } from '@/lib/encryption'
import type { IProviderConnector } from './connectors/connector-interface'
import { getTokenState, ensureAuthenticated, refreshAuthentication } from './token-lifecycle'

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
    getTokenState: async () => {
      return await getTokenState(connector.providerId)
    },
    ensureAuthenticated: async () => {
      const r = await ensureAuthenticated(connector.providerId)
      if (!r.success) return { success: false, error: { code: 'AUTH_FAILED', message: r.error || 'Authentication failed' } }
      return { success: true }
    },
    refreshAuthentication: async () => {
      return await refreshAuthentication(connector.providerId)
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
    validatePurchase: connector.validatePurchase
      ? async (params) => await connector.validatePurchase!(params)
      : undefined,
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

/**
 * Explicitly detects whether a provider should use TemplateProviderAdapter.
 * Uses multiple signals — NOT just endpointMappings — to avoid accidentally
 * classifying Choice/iBASIS as template-driven.
 *
 * Returns true if ANY of these conditions are met:
 * - adapterStrategy === "TEMPLATE"
 * - provider.type === "TEMPLATE"
 * - provider.config?.providerMode === "TEMPLATE"
 * - provider.config?.templateDriven === true
 * - provider has a template relation with providerFamily === "CUSTOM_TEMPLATE"
 */
export function isTemplateDrivenProvider(provider: {
  adapterStrategy?: string | null
  type?: string
  config?: any
  endpointMappings?: any
  template?: any
  providerTemplateId?: string | null
}): boolean {
  // adapterStrategy is the primary signal — explicit non-template strategies must be respected
  if (provider.adapterStrategy === 'AIRHUB') return false // AirHub uses dedicated connector
  if (provider.adapterStrategy === 'TELNA') return false // Telna uses dedicated connector
  if (provider.adapterStrategy === 'TELNA_SEAMLESS') return false // Telna SeamlessOS uses dedicated connector
  if (provider.adapterStrategy === 'TEMPLATE') return true
  if (provider.adapterStrategy && !['TEMPLATE', 'MOCK'].includes(provider.adapterStrategy)) return false
  if (provider.providerTemplateId) return true
  if (provider.type === 'TEMPLATE') return true
  const cfg = provider.config || {}
  if (cfg.providerMode === 'TEMPLATE') return true
  if (cfg.templateDriven === true) return true
  if (provider.template?.providerFamily === 'CUSTOM_TEMPLATE') return true
  return false
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
  template?: any
  environment?: string | null
}): Promise<ProviderAdapter | null> {
  // Template-driven providers use TemplateProviderAdapter
  if (isTemplateDrivenProvider(provider)) {
    console.log(`[TRACE_SYNC] step=buildAdapter code=${provider.code} path=TemplateProviderAdapter isTemplateDriven=true`)
    console.log(`[buildAdapter] Using TemplateProviderAdapter for ${provider.name} (${provider.id}, strategy=${provider.adapterStrategy})`)
    return new TemplateProviderAdapter(provider)
  }

  // Try new connector system for non-template providers (Choice, iBASIS, etc.)
  const connector = await buildConnectorFromProvider(provider.id)
  if (connector) return connectorToAdapter(connector)

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
    // Try buildAdapter first when provider ID is available (handles template-driven providers)
    let adapter: ProviderAdapter
    if (config?.providerId && config.providerId !== 'auth' && config.providerId !== 'undefined') {
      const fullProvider = await prisma.provider.findUnique({ where: { id: config.providerId } })
      if (fullProvider) {
        const built = await buildAdapter(fullProvider)
        if (built) {
          adapter = built
        } else {
          adapter = await getAdapterForType(type, { ...config, providerId: config.providerId })
        }
      } else {
        adapter = await getAdapterForType(type, { ...config, providerId: config.providerId })
      }
    } else {
      adapter = await getAdapterForType(type, { ...config, providerId: config?.providerId || 'auth' })
    }
    console.log(`[PROVIDER_AUTH_CONNECTOR] adapter=${adapter.constructor.name} baseUrl=${(adapter as any).baseUrl || (adapter as any).provider?.apiBaseUrl || 'N/A'}`)
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
