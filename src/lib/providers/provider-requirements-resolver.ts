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
  provider: { code?: string | null; adapterStrategy?: string | null; config?: any }
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
  const adapterStrategy = params.provider.adapterStrategy?.toUpperCase() || ''
  const providerConfig = (params.provider.config as any) || {}

  // 1. ADMIN_OVERRIDE — user explicitly set these
  if (pkgSource === 'ADMIN_OVERRIDE') {
    const result: EffectiveTravelRequirements = {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'ADMIN_OVERRIDE',
    }
    logRequirements('ADMIN_OVERRIDE', result)
    return result
  }

  // 2. Explicit PROVIDER metadata — authoritative plan-level data
  if (pkgSource === 'PROVIDER') {
    const result: EffectiveTravelRequirements = {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'PROVIDER',
    }
    logRequirements('PROVIDER', result)
    return result
  }

  // 3. Provider.config.travelDefaults — runtime-configured provider defaults
  const cfgDefaults = providerConfig.travelDefaults
  if (cfgDefaults && typeof cfgDefaults === 'object') {
    const result: EffectiveTravelRequirements = {
      activationPolicy: cfgDefaults.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: cfgDefaults.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: cfgDefaults.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: cfgDefaults.travelDateMaxAdvanceDays ?? null,
      source: 'PROVIDER_CONFIG',
    }
    logRequirements('PROVIDER_CONFIG', result)
    return result
  }

  // 4. Built-in provider registry — match by adapterStrategy first, then by code.
  // adapterStrategy is the definitive connector identity (e.g. 'AIRHUB').
  // 'code' is the DB identifier. Either can match the built-in registry.
  const strategyMatch = adapterStrategy ? PROVIDER_PURCHASE_DEFAULTS[adapterStrategy] : undefined
  const codeMatch = providerCode ? PROVIDER_PURCHASE_DEFAULTS[providerCode] : undefined
  const builtIn = strategyMatch || codeMatch
  if (builtIn) {
    const result: EffectiveTravelRequirements = { ...builtIn, source: 'PROVIDER_DEFAULTS' }
    logRequirements(`PROVIDER_DEFAULTS(strategy=${adapterStrategy} code=${providerCode})`, result)
    return result
  }

  // 5. TEMPLATE source — use package values from template
  if (pkgSource === 'TEMPLATE') {
    const result: EffectiveTravelRequirements = {
      activationPolicy: pkg.activationPolicy || 'IMMEDIATE',
      travelDateRequirement: pkg.travelDateRequirement || 'NOT_REQUIRED',
      travelDateLeadDays: pkg.travelDateLeadDays ?? 0,
      travelDateMaxAdvanceDays: pkg.travelDateMaxAdvanceDays ?? null,
      source: 'TEMPLATE',
    }
    logRequirements('TEMPLATE', result)
    return result
  }

  // 6. Legacy — travelDateSource is null, do NOT trust schema defaults
  const result: EffectiveTravelRequirements = { ...SAFE_GENERIC_FALLBACK, source: 'SAFE_FALLBACK' }
  logRequirements(`SAFE_FALLBACK(strategy=${adapterStrategy} code=${providerCode})`, result)
  return result
}

function logRequirements(context: string, req: EffectiveTravelRequirements) {
  console.log(`[PROVIDER_REQUIREMENTS_TRACE] source=${req.source} context=${context} activationPolicy=${req.activationPolicy} requirement=${req.travelDateRequirement} leadDays=${req.travelDateLeadDays}`)
}
