import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}))

vi.mock('./connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn().mockResolvedValue(null),
}))

vi.mock('./template-provider-adapter', () => ({
  TemplateProviderAdapter: vi.fn().mockImplementation(function() { this.name = 'TemplateProviderAdapter' }),
}))

vi.mock('./generic-protocol-adapter', () => ({
  GenericProtocolAdapter: vi.fn().mockImplementation(function() { this.name = 'GenericProtocolAdapter' }),
}))

const { buildAdapter, isTemplateDrivenProvider } = await import('./adapter-manager')
const { buildConnectorFromProvider } = await import('./connectors/connector-factory')
const { TemplateProviderAdapter } = await import('./template-provider-adapter')
const { GenericProtocolAdapter } = await import('./generic-protocol-adapter')

const baseProvider = { id: 'prov-1', name: 'Test', code: 'TEST', type: 'REST' }

describe('buildAdapter — legacy registry removed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(buildConnectorFromProvider).mockResolvedValue(null)
  })

  it('does NOT import providerRegistry (module absent)', async () => {
    await expect(import('@/services/providerRegistry')).rejects.toThrow()
  })

  it('template-driven provider resolves to TemplateProviderAdapter', async () => {
    const adapter = await buildAdapter({ ...baseProvider, adapterStrategy: 'TEMPLATE' })
    expect(TemplateProviderAdapter).toHaveBeenCalled()
    expect(adapter).toEqual({ name: 'TemplateProviderAdapter' })
  })

  it('dedicated provider resolves through buildConnectorFromProvider', async () => {
    const mockConnector = { providerId: 'prov-1', name: 'Choice' }
    vi.mocked(buildConnectorFromProvider).mockResolvedValue(mockConnector as any)
    const adapter = await buildAdapter({ ...baseProvider, code: 'CHOICE' })
    expect(buildConnectorFromProvider).toHaveBeenCalledWith('prov-1')
    expect(adapter).toBeDefined()
    expect(adapter?.name).toBe('Choice')
  })

  it('REST_CATALOG resolves to GenericProtocolAdapter', async () => {
    const adapter = await buildAdapter({ ...baseProvider, adapterStrategy: 'REST_CATALOG' })
    expect(GenericProtocolAdapter).toHaveBeenCalled()
    expect(adapter).toEqual({ name: 'GenericProtocolAdapter' })
  })

  it('unknown strategy without connector resolves to GenericProtocolAdapter fallback', async () => {
    const adapter = await buildAdapter({ ...baseProvider, adapterStrategy: 'UNKNOWN_STRATEGY' })
    expect(GenericProtocolAdapter).toHaveBeenCalled()
    expect(adapter).toEqual({ name: 'GenericProtocolAdapter' })
  })
})

describe('isTemplateDrivenProvider — safety invariants', () => {
  it('AIRHUB code always returns false', () => {
    expect(isTemplateDrivenProvider({ code: 'AIRHUB', adapterStrategy: 'TEMPLATE' })).toBe(false)
  })

  it('TELNA strategy always returns false', () => {
    expect(isTemplateDrivenProvider({ code: 'TELNA', adapterStrategy: 'TELNA' })).toBe(false)
  })

  it('TEMPLATE strategy returns true', () => {
    expect(isTemplateDrivenProvider({ adapterStrategy: 'TEMPLATE' })).toBe(true)
  })
})
