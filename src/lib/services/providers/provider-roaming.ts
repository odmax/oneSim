import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { extractNumericValue, extractStringValue } from '@/lib/services/providers/provider-balance'

export interface ProviderRoamingProfile {
  id: string
  code: string
  name: string
  description?: string
  isDefault?: boolean
}

interface RoamingProfilesCache {
  profiles: ProviderRoamingProfile[]
  fetchedAt: string
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function getProviderRoamingProfiles(
  providerId: string,
  options?: { forceRefresh?: boolean },
): Promise<{ success: boolean; profiles: ProviderRoamingProfile[]; source: 'LIVE' | 'CACHE' | 'UNSUPPORTED'; error?: string; fetchedAt?: Date }> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { code: true, type: true, apiBaseUrl: true, apiToken: true, environment: true, authUrl: true, config: true } })
  if (!provider) return { success: false, profiles: [], source: 'UNSUPPORTED', error: 'Provider not found' }

  // Check cache
  if (!options?.forceRefresh && provider.config) {
    const cfg = provider.config as any
    const snap: RoamingProfilesCache | undefined = cfg?.roamingProfilesSnapshot
    if (snap && typeof snap === 'object' && Array.isArray(snap.profiles)) {
      const age = Date.now() - new Date(snap.fetchedAt).getTime()
      if (age < CACHE_TTL_MS) {
        return { success: true, profiles: snap.profiles, source: 'CACHE', fetchedAt: new Date(snap.fetchedAt) }
      }
    }
  }

  // Resolve adapter
  let adapter: any
  try {
    adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
      providerId, environment: provider.environment, authUrl: provider.authUrl,
    })
  } catch (e: any) {
    return { success: false, profiles: [], source: 'UNSUPPORTED', error: `Adapter resolution failed: ${e.message}` }
  }

  if (typeof adapter.getRoamingProfiles !== 'function') {
    return { success: true, profiles: [], source: 'UNSUPPORTED' }
  }

  try {
    const result = await adapter.getRoamingProfiles()
    if (!result || !result.success || !result.data) {
      return { success: false, profiles: [], source: 'LIVE', error: result?.error?.message || 'Failed to fetch roaming profiles' }
    }

    const profiles: ProviderRoamingProfile[] = (result.data as any[]).map((p: any) => ({
      id: extractStringValue(p, ['id', 'code', 'roaming_profile_id', 'profile_id']) || String(p.id || ''),
      code: extractStringValue(p, ['code', 'id', 'roaming_profile_code', 'profile_code']) || String(p.code || p.id || ''),
      name: extractStringValue(p, ['name', 'roaming_profile_name', 'profile_name']) || p.name || p.code || '',
      description: extractStringValue(p, ['description', 'desc']) || undefined,
      isDefault: typeof p.isDefault === 'boolean' ? p.isDefault : typeof p.default === 'boolean' ? p.default : undefined,
    }))

    // Persist to config
    const fetchedAt = new Date()
    try {
      const current = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
      const existingConfig = (current?.config && typeof current.config === 'object') ? { ...(current.config as any) } : {}
      existingConfig.roamingProfilesSnapshot = { profiles, fetchedAt: fetchedAt.toISOString() }
      await prisma.provider.update({ where: { id: providerId }, data: { config: existingConfig } }).catch(() => {})
    } catch {}

    return { success: true, profiles, source: 'LIVE', fetchedAt }
  } catch (e: any) {
    return { success: false, profiles: [], source: 'LIVE', error: `Roaming profiles fetch threw: ${e.message?.substring(0, 200)}` }
  }
}

export async function validateAndRefreshRoamingProfile(
  providerId: string,
  profileId: string | undefined | null,
): Promise<{ valid: boolean; profile?: ProviderRoamingProfile }> {
  if (!profileId) return { valid: true }

  // Try cached first
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { config: true } })
  if (provider?.config) {
    const cfg = provider.config as any
    const snap = cfg?.roamingProfilesSnapshot
    if (snap?.profiles) {
      const match = snap.profiles.find((p: ProviderRoamingProfile) => p.id === profileId || p.code === profileId)
      if (match) return { valid: true, profile: match }
    }
  }

  // Refresh once and retry
  const refreshed = await getProviderRoamingProfiles(providerId, { forceRefresh: true })
  if (refreshed.success) {
    const match = refreshed.profiles.find(p => p.id === profileId || p.code === profileId)
    if (match) return { valid: true, profile: match }
  }

  return { valid: false }
}
