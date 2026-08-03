import { describe, it, expect } from 'vitest'
import { deriveEsimLifecycleStatus, type LifecycleInput } from './lifecycle-status'

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    providerNormalizedStatus: 'ACTIVE',
    currentStatus: 'PENDING_ACTIVATION',
    dataUsedMB: 0,
    activatedAt: null,
    ...overrides,
  }
}

describe('deriveEsimLifecycleStatus', () => {
  it('1. provider ACTIVE with zero usage and no activatedAt → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', dataUsedMB: 0, activatedAt: null }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.setActivatedAt).toBe(false)
    expect(r.reason).toBe('provider-active-no-evidence')
  })

  it('2. provider ACTIVE with usage > 0 and no activatedAt → ACTIVE, set activatedAt', () => {
    const r = deriveEsimLifecycleStatus(input({ dataUsedMB: 512, activatedAt: null }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(true)
    expect(r.reason).toBe('usage-evidence')
  })

  it('3. provider ACTIVE with usage > 0 and existing activatedAt → ACTIVE, no set', () => {
    const r = deriveEsimLifecycleStatus(input({ dataUsedMB: 512, activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(false)
    expect(r.reason).toBe('already-activated')
  })

  it('4. provider ACTIVE with zero usage but existing activatedAt → ACTIVE (preserve history)', () => {
    const r = deriveEsimLifecycleStatus(input({ dataUsedMB: 0, activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(false)
    expect(r.reason).toBe('already-activated')
  })

  it('5. explicit installed signal maps to INSTALLED and sets activatedAt', () => {
    const r = deriveEsimLifecycleStatus(input({ providerInstalledSignal: true, activatedAt: null }))
    expect(r.status).toBe('INSTALLED')
    expect(r.setActivatedAt).toBe(true)
    expect(r.reason).toBe('provider-installed-signal')
  })

  it('6. provider INSTALLED status maps to INSTALLED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'installed', activatedAt: null }))
    expect(r.status).toBe('INSTALLED')
    expect(r.setActivatedAt).toBe(true)
  })

  it('7. provider SUSPENDED maps to SUSPENDED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'ACTIVE' }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.setActivatedAt).toBe(false)
  })

  it('8. provider EXPIRED maps to EXPIRED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'ACTIVE' }))
    expect(r.status).toBe('EXPIRED')
    expect(r.setActivatedAt).toBe(false)
  })

  it('9. provider FAILED maps to FAILED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED' }))
    expect(r.status).toBe('FAILED')
  })

  it('10. provider CANCELLED maps to CANCELLED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED' }))
    expect(r.status).toBe('CANCELLED')
  })

  it('11. provider PENDING maps to PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.setActivatedAt).toBe(false)
  })

  it('12. provider PENDING_ACTIVATION maps to PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING_ACTIVATION' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('13. unknown provider status preserves sticky SUSPENDED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'UNKNOWN_STATE', currentStatus: 'SUSPENDED' }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.setActivatedAt).toBe(false)
  })

  it('14. unknown provider status preserves sticky EXPIRED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'WHATEVER', currentStatus: 'EXPIRED' }))
    expect(r.status).toBe('EXPIRED')
  })

  it('15. unknown provider status with non-sticky current (PENDING_ACTIVATION) → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'RANDOM', currentStatus: 'PENDING_ACTIVATION' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('15b. unknown provider status with ACTIVE → preserves ACTIVE (sticky)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'RANDOM', currentStatus: 'ACTIVE' }))
    expect(r.status).toBe('ACTIVE')
  })

  it('16. SUSPENDED with activatedAt preserves activatedAt (no setActivatedAt)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.setActivatedAt).toBe(false)
  })

  it('17. EXPIRED with activatedAt keeps status', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'ACTIVE', activatedAt: new Date() }))
    expect(r.status).toBe('EXPIRED')
  })

  it('18. provider DISABLED maps to SUSPENDED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'DISABLED' }))
    expect(r.status).toBe('SUSPENDED')
  })

  it('19. Choice-style active + usage 0 → PENDING_ACTIVATION (reproduces the fix)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
    }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.setActivatedAt).toBe(false)
  })

  it('20. First usage detection path: PENDING_ACTIVATION → ACTIVE on usage refresh', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 128,
      activatedAt: null,
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(true)
  })
})
