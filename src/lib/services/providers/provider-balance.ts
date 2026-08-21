import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'

export interface ProviderBalanceResult {
  success: boolean
  supported: boolean
  providerId: string
  providerCode: string
  balance: number | null
  currency: string | null
  accountId?: string | null
  accountName?: string | null
  fetchedAt: Date
  source: 'LIVE' | 'CACHE' | 'CACHE_MISS' | 'UNSUPPORTED'
  error?: string
}

const CACHE_TTL_MS = 60_000

export function extractNumericValue(input: unknown, candidatePaths: readonly string[]): number | null {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object') return null

  for (const path of candidatePaths) {
    const value = resolvePath(input, path)
    if (value === null || value === undefined) continue
    if (typeof value === 'number') {
      if (isNaN(value) || !isFinite(value)) continue
      return value
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) continue
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) continue
      const parsed = parseFloat(trimmed)
      if (isNaN(parsed) || !isFinite(parsed)) continue
      return parsed
    }
  }
  return null
}

export function extractStringValue(input: unknown, candidatePaths: readonly string[]): string | null {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object') return null

  for (const path of candidatePaths) {
    const value = resolvePath(input, path)
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) continue
      return trimmed
    }
    if (typeof value === 'number') {
      return String(value)
    }
  }
  return null
}

function resolvePath(obj: unknown, path: string): unknown {
  if (!path.includes('.')) return (obj as any)?.[path]
  const parts = path.split('.')
  let current: any = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

export function removeBalanceSnapshotFromConfig(config: unknown): Record<string, any> | null {
  if (!config || typeof config !== 'object') return null
  const copy = { ...(config as Record<string, any>) }
  delete copy.balanceSnapshot
  return copy
}

export async function invalidateProviderBalanceSnapshot(providerId: string): Promise<void> {
  try {
    const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
    if (!provider) return
    const current = provider.config
    if (!current || typeof current !== 'object') return
    if (!((current as any).balanceSnapshot)) return
    const cleaned = removeBalanceSnapshotFromConfig(current)
    if (!cleaned) return
    await prisma.provider.update({ where: { id: providerId }, data: { config: cleaned } }).catch(() => {})
  } catch {}
}

function readCachedBalance(config: any): { balance: number | null; currency: string | null; fetchedAt: Date } | null {
  const snap = config?.balanceSnapshot
  if (!snap || typeof snap !== 'object') return null
  const age = Date.now() - new Date(snap.fetchedAt).getTime()
  if (age > CACHE_TTL_MS) return null
  return {
    balance: extractNumericValue(snap, ['balance']),
    currency: extractStringValue(snap, ['currency']),
    fetchedAt: new Date(snap.fetchedAt),
  }
}

async function persistBalanceSnapshot(providerId: string, balance: number | null, currency: string | null, success: boolean) {
  try {
    const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
    const existingConfig = (provider?.config && typeof provider.config === 'object') ? { ...(provider.config as any) } : {}
    existingConfig.balanceSnapshot = { balance, currency, fetchedAt: new Date().toISOString(), success }
    await prisma.provider.update({
      where: { id: providerId },
      data: { config: existingConfig },
    }).catch(() => {})
  } catch {}
}

export async function getProviderBalance(
  providerId: string,
  options?: { forceRefresh?: boolean; maxAgeSeconds?: number; cacheOnly?: boolean },
): Promise<ProviderBalanceResult> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    return { success: false, supported: false, providerId, providerCode: '', balance: null, currency: null, fetchedAt: new Date(), source: 'UNSUPPORTED', error: 'Provider not found' }
  }

  const caps = provider.enabledCapabilities || DEFAULT_PROVIDER_CAPABILITIES[provider.code || ''] || []
  const supportsBalance = (caps as string[]).includes('BALANCE')

  if (!supportsBalance) {
    return { success: true, supported: false, providerId: provider.id, providerCode: provider.code, balance: null, currency: null, fetchedAt: new Date(), source: 'UNSUPPORTED' }
  }

  // Check cache
  if (!options?.forceRefresh && provider.config) {
    const cached = readCachedBalance(provider.config as any)
    if (cached) {
      return {
        success: true, supported: true, providerId: provider.id, providerCode: provider.code,
        balance: cached.balance, currency: cached.currency, accountId: null, accountName: null,
        fetchedAt: cached.fetchedAt, source: 'CACHE',
      }
    }
    // Cache-only mode (purchase hot path): never block on live provider HTTP.
    if (options?.cacheOnly) {
      return { success: true, supported: true, providerId: provider.id, providerCode: provider.code, balance: null, currency: null, fetchedAt: new Date(), source: 'CACHE_MISS' }
    }
  }

  // Resolve adapter
  let adapter: any
  try {
    adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl,
      apiToken: provider.apiToken,
      providerId: provider.id,
      environment: provider.environment,
      authUrl: provider.authUrl,
    })
  } catch (e: any) {
    return { success: false, supported: true, providerId: provider.id, providerCode: provider.code, balance: null, currency: null, fetchedAt: new Date(), source: 'LIVE', error: `Adapter resolution failed: ${e.message}` }
  }

  // Call connector if supported
  if (typeof adapter.getBalance !== 'function') {
    return { success: true, supported: false, providerId: provider.id, providerCode: provider.code, balance: null, currency: null, fetchedAt: new Date(), source: 'UNSUPPORTED' }
  }

  try {
    const result = await adapter.getBalance()

    if (!result || !result.success) {
      await persistBalanceSnapshot(provider.id, null, null, false)
      return {
        success: true, supported: true, providerId: provider.id, providerCode: provider.code,
        balance: null, currency: null, accountId: null, accountName: null,
        fetchedAt: new Date(), source: 'LIVE', error: result?.error?.message || 'Balance fetch failed',
      }
    }

    const raw = result.data || result
    const balance = extractNumericValue(raw, ['balance', 'amount', 'prepaid_balance'])
    const currency = extractStringValue(raw, ['currency'])
    const accountId = extractStringValue(raw, ['accountId', 'account_id', 'account'])
    const accountName = extractStringValue(raw, ['accountName', 'account_name'])

    await persistBalanceSnapshot(provider.id, balance, currency, true)

    return {
      success: true, supported: true, providerId: provider.id, providerCode: provider.code,
      balance, currency, accountId, accountName, fetchedAt: new Date(), source: 'LIVE',
    }
  } catch (e: any) {
    return {
      success: false, supported: true, providerId: provider.id, providerCode: provider.code,
      balance: null, currency: null, fetchedAt: new Date(), source: 'LIVE',
      error: `Balance fetch threw: ${e.message?.substring(0, 200)}`,
    }
  }
}
