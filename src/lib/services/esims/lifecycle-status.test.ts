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

  it('21. assigned (US-Matrix inventory) is NOT treated as ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'assigned',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
    }))
    // "assigned" is allocation state — not device activation.
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.setActivatedAt).toBe(false)
  })

  it('22. free (US-Matrix inventory) is NOT treated as ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'free',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
    }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('23. ACTIVE never regresses to PENDING from a weaker provider report', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'PENDING',
      currentStatus: 'ACTIVE',
      dataUsedMB: 0,
      activatedAt: new Date('2026-01-01'),
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('monotonic-preserve-active')
  })

  it('24. INSTALLED never regresses to PROCESSING from a weaker provider report', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'PROCESSING',
      currentStatus: 'INSTALLED',
      dataUsedMB: 0,
      activatedAt: new Date('2026-01-01'),
    }))
    expect(r.status).toBe('INSTALLED')
    expect(r.reason).toBe('monotonic-preserve-active')
  })

  it('25. ACTIVE still transitions to SUSPENDED / EXPIRED (terminal/stronger states)', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'ACTIVE', activatedAt: new Date() })).status).toBe('SUSPENDED')
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'ACTIVE', activatedAt: new Date() })).status).toBe('EXPIRED')
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'ACTIVE', activatedAt: new Date() })).status).toBe('FAILED')
  })

  it('26. SUSPENDED can resume to ACTIVE when provider reports explicit device-active evidence', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'SUSPENDED',
      dataUsedMB: 64,
      activatedAt: new Date('2026-01-01'),
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('already-activated')
  })

  it('27. positive per-eSIM usage promotes PENDING_ACTIVATION → ACTIVE (documented policy)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 1,
      activatedAt: null,
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(true)
    expect(r.reason).toBe('usage-evidence')
  })

  it('28. VERIFIED network attach (zero usage, no history) promotes PENDING_ACTIVATION → ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
      providerNetworkAttachedSignal: true,
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(true)
    expect(r.reason).toBe('network-attach-evidence')
  })

  it('29. VERIFIED network attach does not overwrite an existing activatedAt', () => {
    const existing = new Date('2026-01-01')
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'ACTIVE',
      dataUsedMB: 0,
      activatedAt: existing,
      providerNetworkAttachedSignal: true,
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(false)
  })

  it('30. VERIFIED network attach without providerNormalizedStatus ACTIVE still maps to ACTIVE when connector normalizes it', () => {
    // A future connector returning the same canonical ACTIVE + evidence shape
    // receives the same promotion — provider-neutral.
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
      providerNetworkAttachedSignal: true,
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.setActivatedAt).toBe(true)
  })

  it('31. SUSPENDED can resume to ACTIVE when the connector proves network attach', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'SUSPENDED',
      dataUsedMB: 0,
      activatedAt: new Date('2026-01-01'),
      providerNetworkAttachedSignal: true,
    }))
    expect(r.status).toBe('ACTIVE')
  })

  it('32. weak "active" claim WITHOUT verified evidence still stays PENDING (Choice-style preserved)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE',
      currentStatus: 'PENDING_ACTIVATION',
      dataUsedMB: 0,
      activatedAt: null,
      providerNetworkAttachedSignal: false,
    }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.reason).toBe('provider-active-no-evidence')
  })
})
