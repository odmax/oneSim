import { describe, it, expect } from 'vitest'
import { resolveConnectorType } from './connector-type'
import { isTemplateDrivenProvider } from '../adapter-manager'

/**
 * CANONICAL AIRHUB CONNECTOR RESOLUTION AUDIT — regression suite.
 *
 * The AirHub clean rebuild (fd3c178) removed the template-driven AirHub
 * integration mode and introduced a dedicated AirHubConnector. A stale
 * `adapterStrategy=TEMPLATE` value persisted in staging is therefore STALE, not
 * an alternate supported integration mode. The safety invariant is:
 *
 *   provider.code === 'AIRHUB'  →  AirHubConnector, ALWAYS, regardless of
 *   a stale/generic strategy (TEMPLATE, CUSTOM, REST_CATALOG, STANDARD, or
 *   empty/null).
 *
 * This exact-code match must never bleed onto generic/template/future
 * providers, and explicit dedicated non-AirHub strategies still win.
 */

describe('AirHub canonical connector resolution (exact-code safety invariant)', () => {
  it('1. strategy=AIRHUB, type=CUSTOM, code=AIRHUB → AIRHUB (dedicated)', () => {
    expect(resolveConnectorType('AIRHUB', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
  })

  it('2. stale strategy=TEMPLATE, type=CUSTOM, code=AIRHUB → AIRHUB (NOT REST_CATALOG)', () => {
    // This is the CURRENT STAGING STATE. The invariant must rescue it from the
    // generic REST_CATALOG fallback the legacy resolver produced.
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
  })

  it('3. legacy strategy=CUSTOM, type=CUSTOM, code=AIRHUB → AIRHUB', () => {
    expect(resolveConnectorType('CUSTOM', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
  })

  it('4. strategy=null/empty, type=CUSTOM, code=AIRHUB → AIRHUB (never generic)', () => {
    expect(resolveConnectorType(null, 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
    expect(resolveConnectorType('', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
    expect(resolveConnectorType(undefined, 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
  })

  it('5. generic strategies persisted on AIRHUB stay dedicated', () => {
    // An admin-edited/stale REST_CATALOG or STANDARD strategy must NOT silently
    // downgrade AirHub to the generic adapter.
    expect(resolveConnectorType('REST_CATALOG', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
    expect(resolveConnectorType('STANDARD', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
    expect(resolveConnectorType('URL_TOKEN', 'CUSTOM', 'AIRHUB')).toBe('AIRHUB')
  })

  it('6. explicit dedicated non-AirHub strategies still win (no misrouting)', () => {
    // Even with code AIRHUB, an explicit TELNA/TELNA_SEAMLESS/TELNA_FLEX/IBASIS/
    // USMATRIX strategy resolves to its own dedicated connector — but these
    // combinations are not expected in practice and are here to document that
    // the code-override only guards the stale/generic bucket.
    expect(resolveConnectorType('TELNA', 'CUSTOM', 'AIRHUB')).toBe('TELNA')
    expect(resolveConnectorType('IBASIS', 'CUSTOM', 'AIRHUB')).toBe('IBASIS')
    expect(resolveConnectorType('USMATRIX', 'CUSTOM', 'AIRHUB')).toBe('USMATRIX')
  })
})

describe('Generic TEMPLATE providers remain UNCHANGED (REST_CATALOG)', () => {
  it('7. strategy=TEMPLATE, code=some future template provider → REST_CATALOG', () => {
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'RAKUTEN')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'SOME_FUTURE_PROVIDER')).toBe('REST_CATALOG')
  })

  it('8. TEMPLATE with no/unknown code → REST_CATALOG', () => {
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', undefined)).toBe('REST_CATALOG')
  })

  it('9. no generic provider is routed to AirHub by name or loose matching', () => {
    // Anything that is not an exact 'AIRHUB' code must NOT become AirHub.
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'AIRHUB2')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'airhub')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'AIR')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TEMPLATE', 'CUSTOM', 'MOCK')).toBe('REST_CATALOG')
    expect(resolveConnectorType(null, 'CUSTOM', 'RAKUTEN')).toBe('REST_CATALOG')
  })
})

describe('Other providers remain UNCHANGED', () => {
  it('10. Choice / Telna / iBASIS / US-Matrix resolutions are untouched', () => {
    expect(resolveConnectorType('CHOICE', 'CHOICE', 'CHOICE')).toBe('URL_TOKEN')
    expect(resolveConnectorType('CHOICE', 'CUSTOM', 'CHOICE')).toBe('URL_TOKEN')
    expect(resolveConnectorType('TELNA', 'CUSTOM', 'TELNA')).toBe('TELNA')
    expect(resolveConnectorType('TELNA_SEAMLESS', 'CUSTOM', 'TELNA')).toBe('TELNA_SEAMLESS')
    expect(resolveConnectorType('TELNA_FLEX', 'CUSTOM', 'TELNA')).toBe('TELNA_FLEX')
    expect(resolveConnectorType('IBASIS', 'CUSTOM', 'IBASIS')).toBe('IBASIS')
    expect(resolveConnectorType('USMATRIX', 'CUSTOM', 'USMATRIX')).toBe('USMATRIX')
    expect(resolveConnectorType('REST_CATALOG', 'CUSTOM', 'RAKUTEN')).toBe('REST_CATALOG')
    expect(resolveConnectorType('STANDARD', 'CUSTOM')).toBe('STANDARD')
  })

  it('11. MOCK short-circuit still wins', () => {
    expect(resolveConnectorType(undefined, 'MOCK', 'AIRHUB')).toBe('MOCK')
    expect(resolveConnectorType('TEMPLATE', 'MOCK', 'X')).toBe('MOCK')
  })
})

describe('isTemplateDrivenProvider — adapter-path mirror of the invariant', () => {
  it('12. AirHub code is NEVER template-driven, even with stale TEMPLATE strategy', () => {
    // Mirrors resolveConnectorType so plan sync and connector routing agree.
    expect(isTemplateDrivenProvider({ code: 'AIRHUB', adapterStrategy: 'TEMPLATE', config: { providerMode: 'TEMPLATE', templateDriven: true } })).toBe(false)
    expect(isTemplateDrivenProvider({ code: 'AIRHUB', adapterStrategy: 'AIRHUB' })).toBe(false)
    expect(isTemplateDrivenProvider({ code: 'AIRHUB', type: 'CUSTOM', config: { templateDriven: true } })).toBe(false)
  })

  it('13. generic TEMPLATE providers remain template-driven', () => {
    expect(isTemplateDrivenProvider({ code: 'RAKUTEN', adapterStrategy: 'TEMPLATE', providerTemplateId: 'tpl-1' })).toBe(true)
    expect(isTemplateDrivenProvider({ code: 'RAKUTEN', adapterStrategy: 'TEMPLATE' })).toBe(true)
    expect(isTemplateDrivenProvider({ code: 'CHOICE', adapterStrategy: 'CHOICE' })).toBe(false)
    expect(isTemplateDrivenProvider({ code: 'TELNA', adapterStrategy: 'TELNA' })).toBe(false)
    expect(isTemplateDrivenProvider({ code: 'USMATRIX', adapterStrategy: 'USMATRIX' })).toBe(false)
  })
})