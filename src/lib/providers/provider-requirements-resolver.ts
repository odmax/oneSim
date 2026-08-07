/**
 * Provider-level purchase requirement defaults.
 * Source-controlled registry — provider-wide, not package-specific.
 *
 * Provider.config.travelDefaults overrides these at runtime.
 */
export const PROVIDER_PURCHASE_DEFAULTS: Record<string, {
  activationPolicy: string
  travelDateRequirement: string
  travelDateLeadDays: number
  travelDateMaxAdvanceDays: number | null
}> = {
  AIRHUB: {
    activationPolicy: 'FLEXIBLE',
    travelDateRequirement: 'REQUIRED',
    travelDateLeadDays: 0,
    travelDateMaxAdvanceDays: null,
  },
  CHOICE: {
    activationPolicy: 'IMMEDIATE',
    travelDateRequirement: 'NOT_REQUIRED',
    travelDateLeadDays: 0,
    travelDateMaxAdvanceDays: null,
  },
  IBASIS: {
    activationPolicy: 'IMMEDIATE',
    travelDateRequirement: 'NOT_REQUIRED',
    travelDateLeadDays: 0,
    travelDateMaxAdvanceDays: null,
  },
  TELNA: {
    activationPolicy: 'IMMEDIATE',
    travelDateRequirement: 'NOT_REQUIRED',
    travelDateLeadDays: 0,
    travelDateMaxAdvanceDays: null,
  },
}

const SAFE_GENERIC_FALLBACK = {
  activationPolicy: 'IMMEDIATE',
  travelDateRequirement: 'NOT_REQUIRED',
  travelDateLeadDays: 0,
  travelDateMaxAdvanceDays: null,
}

export interface EffectiveTravelRequirements {
  activationPolicy: string
  travelDateRequirement: string
  travelDateLeadDays: number
  travelDateMaxAdvanceDays: number | null
  source: string
}

/**
 * Resolves effective travel requirements by merging provider-level defaults
 * with package-level explicit overrides.
 *
 * Precedence:
 *   1. ADMIN_OVERRIDE package values
 *   2. Explicit package PROVIDER metadata (travelDateSource = 'PROVIDER')
 *   3. Provider.config.travelDefaults
 *   4. Built-in PROVIDER_PURCHASE_DEFAULTS registry
 *   5. Package TEMPLATE values (travelDateSource = 'TEMPLATE')
 *   6. Safe generic fallback
 *
 * LEGACY SAFETY: Package values with travelDateSource = null are Prisma defaults
 * and must NOT override provider defaults. This prevents AirHub packages from
 * regressing to NOT_REQUIRED when their record has only schema defaults.
 */
export function resolveEffectiveProviderRequirements(params: {
  provider: { code?: string | null; config?: any }
  providerPackage: {
    activationPolicy?: string | null
    travelDateRequirement?: string | null
    travelDateLeadDays?: number | null
    travelDateMaxAdvanceDays?: number | null
    travelDateSource?: string | null
  }
}): EffectiveTravelRequirements {
  const pkg = params.providerPackage
  const pkgSource = pkg.travelDateSource || null
  const providerCode = params.provider.code?.toUpperCase() || ''
  const providerConfig = (params.provider.config as any) || {}

  // 1. ADMIN_OVERRIDE — user explicitly set these
  if (pkgSource === 'ADMIN_OVERRIDE') {
    return {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'ADMIN_OVERRIDE',
    }
  }

  // 2. Explicit PROVIDER metadata — authoritative plan-level data
  if (pkgSource === 'PROVIDER') {
    return {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'PROVIDER',
    }
  }

  // 3. Provider.config.travelDefaults — runtime-configured provider defaults
  const cfgDefaults = providerConfig.travelDefaults
  if (cfgDefaults && typeof cfgDefaults === 'object') {
    return {
      activationPolicy: cfgDefaults.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: cfgDefaults.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: cfgDefaults.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: cfgDefaults.travelDateMaxAdvanceDays ?? null,
      source: 'PROVIDER_CONFIG',
    }
  }

  // 4. Built-in provider registry
  const builtIn = PROVIDER_PURCHASE_DEFAULTS[providerCode]
  if (builtIn) {
    return {
      ...builtIn,
      source: 'PROVIDER_DEFAULTS',
    }
  }

  // 5. TEMPLATE source — use package values from template
  if (pkgSource === 'TEMPLATE') {
    return {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'TEMPLATE',
    }
  }

  // 6. Legacy — travelDateSource is null, do NOT trust schema defaults
  // Fall through to generic safe fallback (NOT_REQUIRED for unknown providers)
  return { ...SAFE_GENERIC_FALLBACK, source: 'SAFE_FALLBACK' }
}
