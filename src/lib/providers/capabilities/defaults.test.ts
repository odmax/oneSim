import { describe, it, expect } from 'vitest'
import { DEFAULT_PROVIDER_CAPABILITIES } from './defaults'
import { ProviderCapability } from './types'

describe('DEFAULT_PROVIDER_CAPABILITIES — US-Matrix alignment', () => {
  it('US-Matrix declares the wired capability set (PURCHASE/STATUS/USAGE/SUSPEND/RESUME/INVENTORY)', () => {
    const caps = DEFAULT_PROVIDER_CAPABILITIES.USMATRIX
    expect(caps).toContain(ProviderCapability.AUTH)
    expect(caps).toContain(ProviderCapability.CATALOG_SYNC)
    expect(caps).toContain(ProviderCapability.INVENTORY)
    expect(caps).toContain(ProviderCapability.ESIM)
    expect(caps).toContain(ProviderCapability.PURCHASE)
    expect(caps).toContain(ProviderCapability.STATUS)
    expect(caps).toContain(ProviderCapability.USAGE)
    expect(caps).toContain(ProviderCapability.SUSPEND)
    expect(caps).toContain(ProviderCapability.RESUME)
  })

  it('US-Matrix does NOT declare unwired/unproven capabilities (TOP_UP/BALANCE/CANCEL/WEBHOOKS)', () => {
    const caps = DEFAULT_PROVIDER_CAPABILITIES.USMATRIX
    expect(caps).not.toContain(ProviderCapability.TOP_UP)
    expect(caps).not.toContain(ProviderCapability.BALANCE)
    expect(caps).not.toContain(ProviderCapability.CANCEL)
    expect(caps).not.toContain(ProviderCapability.WEBHOOKS)
  })

  it('declarations are keyed by provider code only (no generic-code coupling)', () => {
    // Each provider has its own capability list; US-Matrix entries live only in
    // the USMATRIX key — no global capability change affects other providers.
    expect(DEFAULT_PROVIDER_CAPABILITIES.CHOICE).toContain(ProviderCapability.PURCHASE)
    expect(DEFAULT_PROVIDER_CAPABILITIES.AIRHUB).toContain(ProviderCapability.PURCHASE)
    expect(DEFAULT_PROVIDER_CAPABILITIES.IBASIS).toContain(ProviderCapability.PURCHASE)
    expect(DEFAULT_PROVIDER_CAPABILITIES.USMATRIX).toContain(ProviderCapability.PURCHASE)
  })
})
