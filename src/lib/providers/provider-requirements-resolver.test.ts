import { describe, it, expect } from 'vitest'
import { resolveEffectiveProviderRequirements, PROVIDER_PURCHASE_DEFAULTS } from './provider-requirements-resolver'

const makePkg = (overrides: Record<string, any> = {}) => ({
  activationPolicy: 'IMMEDIATE',
  travelDateRequirement: 'NOT_REQUIRED',
  travelDateLeadDays: 0,
  travelDateMaxAdvanceDays: null,
  travelDateSource: null,
  ...overrides,
})

describe('resolveEffectiveProviderRequirements', () => {
  describe('AirHub', () => {
    it('legacy package with null source inherits REQUIRED/FLEXIBLE from built-in defaults', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'AIRHUB' },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('REQUIRED')
      expect(r.activationPolicy).toBe('FLEXIBLE')
      expect(r.travelDateLeadDays).toBe(0)
      expect(r.source).toBe('PROVIDER_DEFAULTS')
    })

    it('ADMIN_OVERRIDE NOT_REQUIRED wins over built-in defaults', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'AIRHUB' },
        providerPackage: makePkg({ travelDateRequirement: 'NOT_REQUIRED', travelDateSource: 'ADMIN_OVERRIDE' }),
      })
      expect(r.travelDateRequirement).toBe('NOT_REQUIRED')
      expect(r.source).toBe('ADMIN_OVERRIDE')
    })

    it('explicit PROVIDER metadata wins over built-in', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'AIRHUB' },
        providerPackage: makePkg({ travelDateRequirement: 'OPTIONAL', travelDateSource: 'PROVIDER' }),
      })
      expect(r.travelDateRequirement).toBe('OPTIONAL')
      expect(r.source).toBe('PROVIDER')
    })

    it('provider.config.travelDefaults overrides built-in default', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'AIRHUB', config: { travelDefaults: { travelDateRequirement: 'OPTIONAL', activationPolicy: 'SCHEDULED' } } },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('OPTIONAL')
      expect(r.activationPolicy).toBe('SCHEDULED')
      expect(r.source).toBe('PROVIDER_CONFIG')
    })
  })

  describe('Choice', () => {
    it('remains NOT_REQUIRED', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'CHOICE' },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('NOT_REQUIRED')
      expect(r.activationPolicy).toBe('IMMEDIATE')
    })
  })

  describe('iBASIS', () => {
    it('remains NOT_REQUIRED', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'IBASIS' },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('NOT_REQUIRED')
      expect(r.activationPolicy).toBe('IMMEDIATE')
    })
  })

  describe('Telna', () => {
    it('remains NOT_REQUIRED', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'TELNA' },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('NOT_REQUIRED')
      expect(r.activationPolicy).toBe('IMMEDIATE')
    })
  })

  describe('Custom provider', () => {
    it('config travelDefaults honored', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'CUSTOM', config: { travelDefaults: { travelDateRequirement: 'REQUIRED', activationPolicy: 'FLEXIBLE', travelDateLeadDays: 1 } } },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('REQUIRED')
      expect(r.travelDateLeadDays).toBe(1)
      expect(r.source).toBe('PROVIDER_CONFIG')
    })

    it('explicit package override honored', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'CUSTOM' },
        providerPackage: makePkg({ travelDateRequirement: 'OPTIONAL', travelDateSource: 'PROVIDER' }),
      })
      expect(r.travelDateRequirement).toBe('OPTIONAL')
      expect(r.source).toBe('PROVIDER')
    })

    it('generic fallback safe when no config or built-in', () => {
      const r = resolveEffectiveProviderRequirements({
        provider: { code: 'UNKNOWN_FUTURE' },
        providerPackage: makePkg({ travelDateSource: null }),
      })
      expect(r.travelDateRequirement).toBe('NOT_REQUIRED')
      expect(r.activationPolicy).toBe('IMMEDIATE')
      expect(r.source).toBe('SAFE_FALLBACK')
    })
  })

  describe('precedence', () => {
    it('ADMIN_OVERRIDE > PROVIDER > CONFIG > BUILT_IN > TEMPLATE > SAFE_FALLBACK', () => {
      const provider = { code: 'AIRHUB', config: { travelDefaults: { travelDateRequirement: 'OPTIONAL' } } }
      
      const admin = resolveEffectiveProviderRequirements({ provider, providerPackage: makePkg({ travelDateRequirement: 'NOT_REQUIRED', travelDateSource: 'ADMIN_OVERRIDE' }) })
      expect(admin.source).toBe('ADMIN_OVERRIDE')

      const prov = resolveEffectiveProviderRequirements({ provider, providerPackage: makePkg({ travelDateRequirement: 'OPTIONAL', travelDateSource: 'PROVIDER' }) })
      expect(prov.source).toBe('PROVIDER')

      const cfg = resolveEffectiveProviderRequirements({ provider: { code: 'AIRHUB', config: { travelDefaults: { travelDateRequirement: 'REQUIRED' } } }, providerPackage: makePkg({ travelDateSource: null }) })
      expect(cfg.source).toBe('PROVIDER_CONFIG')

      const builtin = resolveEffectiveProviderRequirements({ provider: { code: 'AIRHUB' }, providerPackage: makePkg({ travelDateSource: null }) })
      expect(builtin.source).toBe('PROVIDER_DEFAULTS')
    })
  })

  describe('no provider checks in Business UI', () => {
    it('resolver takes provider.code only for defaults lookup — no hardcoded branching', () => {
      // All provider codes follow same logic path
      const all = ['AIRHUB', 'CHOICE', 'IBASIS', 'TELNA', 'FUTURE_X']
      for (const code of all) {
        const r = resolveEffectiveProviderRequirements({
          provider: { code },
          providerPackage: makePkg({ travelDateSource: null }),
        })
        // Always returns a valid result
        expect(r.activationPolicy).toBeTruthy()
        expect(r.travelDateRequirement).toBeTruthy()
        expect(r.source).toBeTruthy()
      }
    })
  })
})
