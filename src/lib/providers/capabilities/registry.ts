import type { ProviderCapability } from './types'
import { DEFAULT_PROVIDER_CAPABILITIES } from './defaults'

export interface CapabilityProvider {
  id: string
  name?: string
  code?: string
  type: string
  capabilities?: string[] | null
  enabledCapabilities?: any
}

export function parseCapabilities(provider: CapabilityProvider | null | undefined): ProviderCapability[] {
  if (!provider) return []

  // Check explicit capabilities first
  const raw = provider.capabilities || provider.enabledCapabilities
  if (Array.isArray(raw) && raw.length > 0) return raw as ProviderCapability[]

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const arr: string[] = []
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val === 'string') arr.push(val)
      else if (val && typeof val === 'object' && (val as any).enabled) arr.push(key)
    }
    if (arr.length > 0) return arr as ProviderCapability[]
  }

  // Fall back to defaults by provider code
  const code = provider.code?.toUpperCase() || ''
  if (DEFAULT_PROVIDER_CAPABILITIES[code]) {
    return DEFAULT_PROVIDER_CAPABILITIES[code]
  }

  return []
}

export function providerSupports(
  provider: CapabilityProvider | null | undefined,
  capability: ProviderCapability,
): boolean {
  const caps = parseCapabilities(provider)
  return caps.includes(capability)
}

export function getProviderCapabilities(provider: CapabilityProvider | null | undefined): ProviderCapability[] {
  return parseCapabilities(provider)
}

export function requireProviderCapability(
  provider: CapabilityProvider | null | undefined,
  capability: ProviderCapability,
): void {
  if (!providerSupports(provider, capability)) {
    throw new Error(`Provider ${provider?.name || provider?.code || 'unknown'} does not support capability: ${capability}`)
  }
}

export function getMissingCapabilities(
  provider: CapabilityProvider | null | undefined,
  required: ProviderCapability[],
): ProviderCapability[] {
  const caps = parseCapabilities(provider)
  return required.filter(c => !caps.includes(c))
}
