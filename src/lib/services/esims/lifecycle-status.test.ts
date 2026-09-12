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

describe('deriveEsimLifecycleStatus — Phase 1 hardening transition matrix', () => {
  // ── PENDING ─────────────────────────────────────────────
  it('33. PENDING + recognized pending → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING', currentStatus: 'PENDING' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.reason).toBe('provider-pending')
  })

  it('34. PENDING + ACTIVE without evidence → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'PENDING', dataUsedMB: 0, activatedAt: null }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.reason).toBe('provider-active-no-evidence')
  })

  it('35. PENDING + ACTIVE with verified network evidence → ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'PENDING', providerNetworkAttachedSignal: true }))
    expect(r.status).toBe('ACTIVE')
  })

  it('36. PENDING + device-installed signal → INSTALLED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'INSTALLED', currentStatus: 'PENDING', providerInstalledSignal: true }))
    expect(r.status).toBe('INSTALLED')
  })

  it('37. PENDING + SUSPENDED → SUSPENDED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'PENDING' })).status).toBe('SUSPENDED')
  })

  it('38. PENDING + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'PENDING' })).status).toBe('EXPIRED')
  })

  it('39. PENDING + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'PENDING' })).status).toBe('FAILED')
  })

  it('40. PENDING + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'PENDING' })).status).toBe('CANCELLED')
  })

  // ── PROCESSING (internal/transient claim state) ─────────
  it('41. PROCESSING + weaker provider result → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PROCESSING', currentStatus: 'PROCESSING' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('42. PROCESSING + ACTIVE without evidence → PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'PROCESSING', dataUsedMB: 0, activatedAt: null }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.reason).toBe('provider-active-no-evidence')
  })

  it('43. PROCESSING + ACTIVE with usage evidence → ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'PROCESSING', dataUsedMB: 256 }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('usage-evidence')
  })

  it('44. PROCESSING + device-installed signal → INSTALLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'IN_USE', currentStatus: 'PROCESSING', providerInstalledSignal: true })).status).toBe('INSTALLED')
  })

  it('45. PROCESSING + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'PROCESSING' })).status).toBe('EXPIRED')
  })

  it('46. PROCESSING + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'PROCESSING' })).status).toBe('FAILED')
  })

  it('47. PROCESSING + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'PROCESSING' })).status).toBe('CANCELLED')
  })

  // ── PENDING_ACTIVATION ──────────────────────────────────
  it('48. PENDING_ACTIVATION + ACTIVE without evidence stays PENDING_ACTIVATION', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'PENDING_ACTIVATION', dataUsedMB: 0, activatedAt: null,
    }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('49. PENDING_ACTIVATION + ACTIVE with activation history → ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'PENDING_ACTIVATION', dataUsedMB: 0, activatedAt: new Date('2026-01-01'),
    }))
    expect(r.status).toBe('ACTIVE')
  })

  it('50. PENDING_ACTIVATION + device-installed signal → INSTALLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ONLINE', currentStatus: 'PENDING_ACTIVATION', providerInstalledSignal: true })).status).toBe('INSTALLED')
  })

  it('51. PENDING_ACTIVATION + SUSPENDED → SUSPENDED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'PENDING_ACTIVATION' })).status).toBe('SUSPENDED')
  })

  it('52. PENDING_ACTIVATION + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'PENDING_ACTIVATION' })).status).toBe('EXPIRED')
  })

  it('53. PENDING_ACTIVATION + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'PENDING_ACTIVATION' })).status).toBe('FAILED')
  })

  it('54. PENDING_ACTIVATION + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'PENDING_ACTIVATION' })).status).toBe('CANCELLED')
  })

  // ── INSTALLED (device-install evidence) ─────────────────
  it('55. INSTALLED + unknown provider value preserves INSTALLED (regression: no drop to PENDING_ACTIVATION)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'INACTIVE', currentStatus: 'INSTALLED' }))
    expect(r.status).toBe('INSTALLED')
    expect(r.reason).toBe('preserve-current-on-unknown-provider')
  })

  it('56. INSTALLED + known weak provisioning value preserves INSTALLED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING', currentStatus: 'INSTALLED' }))
    expect(r.status).toBe('INSTALLED')
    expect(r.reason).toBe('monotonic-preserve-active')
  })

  it('57. INSTALLED + PROCESSING report preserves INSTALLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PROCESSING', currentStatus: 'INSTALLED' })).status).toBe('INSTALLED')
  })

  it('58. INSTALLED + ACTIVE without sufficient evidence preserves INSTALLED (no fabricated ACTIVE)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'INSTALLED', dataUsedMB: 0, activatedAt: null, providerNetworkAttachedSignal: false,
    }))
    expect(r.status).toBe('INSTALLED')
    expect(r.reason).toBe('preserve-authoritative-on-weak-active')
  })

  it('59. INSTALLED + ACTIVE with usage evidence may become ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'INSTALLED', dataUsedMB: 128 }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('usage-evidence')
  })

  it('60. INSTALLED + ACTIVE with activation history may become ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'INSTALLED', dataUsedMB: 0, activatedAt: new Date('2026-01-01'),
    }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('already-activated')
  })

  it('61. INSTALLED + SUSPENDED → SUSPENDED (recognized authoritative move)', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'INSTALLED' })).status).toBe('SUSPENDED')
  })

  it('62. INSTALLED + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'INSTALLED' })).status).toBe('EXPIRED')
  })

  it('63. INSTALLED + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'INSTALLED' })).status).toBe('FAILED')
  })

  it('64. INSTALLED + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'INSTALLED' })).status).toBe('CANCELLED')
  })

  // ── ACTIVE ──────────────────────────────────────────────
  it('65. ACTIVE + unknown provider value preserves ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'WHATEVER', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('ACTIVE')
  })

  it('66. ACTIVE + weak provisioning value preserves ACTIVE (monotonic)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING_ACTIVATION', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('ACTIVE')
    expect(r.reason).toBe('monotonic-preserve-active')
  })

  it('67. ACTIVE + ACTIVE remains ACTIVE', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') })).status).toBe('ACTIVE')
  })

  it('68. ACTIVE + SUSPENDED → SUSPENDED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SUSPENDED', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') })).status).toBe('SUSPENDED')
  })

  it('69. ACTIVE + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') })).status).toBe('EXPIRED')
  })

  it('70. ACTIVE + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') })).status).toBe('FAILED')
  })

  it('71. ACTIVE + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'ACTIVE', activatedAt: new Date('2026-01-01') })).status).toBe('CANCELLED')
  })

  // ── SUSPENDED (reversible only with canonical evidence) ─
  it('72. SUSPENDED + unknown provider value stays SUSPENDED (no drop to PENDING_ACTIVATION)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'SOMETHING_NEW', currentStatus: 'SUSPENDED' }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.reason).toBe('preserve-current-on-unknown-provider')
  })

  it('73. SUSPENDED + weaker provisioning value stays SUSPENDED (no silent resurrection)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING', currentStatus: 'SUSPENDED' }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.reason).toBe('monotonic-preserve-active')
  })

  it('74. SUSPENDED + ACTIVE without evidence stays SUSPENDED (no resume, no resurrection)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'SUSPENDED', dataUsedMB: 0, activatedAt: null, providerNetworkAttachedSignal: false,
    }))
    expect(r.status).toBe('SUSPENDED')
    expect(r.reason).toBe('preserve-authoritative-on-weak-active')
  })

  it('75. SUSPENDED + ACTIVE with verified network evidence resumes ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'SUSPENDED', providerNetworkAttachedSignal: true }))
    expect(r.status).toBe('ACTIVE')
  })

  it('76. SUSPENDED + ACTIVE with usage evidence resumes ACTIVE', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'SUSPENDED', dataUsedMB: 12 }))
    expect(r.status).toBe('ACTIVE')
  })

  it('77. SUSPENDED + EXPIRED → EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'EXPIRED', currentStatus: 'SUSPENDED' })).status).toBe('EXPIRED')
  })

  it('78. SUSPENDED + CANCELLED → CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'CANCELLED', currentStatus: 'SUSPENDED' })).status).toBe('CANCELLED')
  })

  it('79. SUSPENDED + FAILED → FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'SUSPENDED' })).status).toBe('FAILED')
  })

  // ── EXPIRED (canonical terminal — never resurrected) ────
  it('80. EXPIRED + unknown provider value preserves EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'UNKNOWN_STATE', currentStatus: 'EXPIRED' })).status).toBe('EXPIRED')
  })

  it('81. EXPIRED + weaker provisioning value preserves EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING', currentStatus: 'EXPIRED' })).status).toBe('EXPIRED')
  })

  it('82. EXPIRED + ACTIVE report (even with usage evidence) preserves EXPIRED', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'EXPIRED', dataUsedMB: 500, activatedAt: new Date('2026-01-01') }))
    expect(r.status).toBe('EXPIRED')
    expect(r.reason).toBe('preserve-terminal')
  })

  it('83. EXPIRED + device-installed signal preserves EXPIRED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'INSTALLED', currentStatus: 'EXPIRED', providerInstalledSignal: true })).status).toBe('EXPIRED')
  })

  // ── FAILED (canonical terminal — never resurrected) ─────
  it('84. FAILED + unknown provider value preserves FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'RANDOM', currentStatus: 'FAILED' })).status).toBe('FAILED')
  })

  it('85. FAILED + weaker provisioning value preserves FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING', currentStatus: 'FAILED' })).status).toBe('FAILED')
  })

  it('86. FAILED + ACTIVE report with full evidence preserves FAILED (no resurrection)', () => {
    const r = deriveEsimLifecycleStatus(input({
      providerNormalizedStatus: 'ACTIVE', currentStatus: 'FAILED', dataUsedMB: 200, activatedAt: new Date('2026-01-01'), providerNetworkAttachedSignal: true,
    }))
    expect(r.status).toBe('FAILED')
    expect(r.reason).toBe('preserve-terminal')
  })

  it('87. FAILED + INSTALLED provider value preserves FAILED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'INSTALLED', currentStatus: 'FAILED' })).status).toBe('FAILED')
  })

  // ── CANCELLED (canonical terminal — never resurrected) ──
  it('88. CANCELLED + unknown provider value preserves CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'BOGUS', currentStatus: 'CANCELLED' })).status).toBe('CANCELLED')
  })

  it('89. CANCELLED + weaker provisioning value preserves CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'PENDING_ACTIVATION', currentStatus: 'CANCELLED' })).status).toBe('CANCELLED')
  })

  it('90. CANCELLED + ACTIVE report preserves CANCELLED (no resurrection)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'CANCELLED', dataUsedMB: 0, activatedAt: null }))
    expect(r.status).toBe('CANCELLED')
    expect(r.reason).toBe('preserve-terminal')
  })

  it('91. CANCELLED + device-installed signal preserves CANCELLED', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ONLINE', currentStatus: 'CANCELLED', providerInstalledSignal: true })).status).toBe('CANCELLED')
  })

  // ── REFUNDED (money/business state — not lifecycle-sticky; semantics unchanged)
  it('92. REFUNDED + unknown provider value → PENDING_ACTIVATION (characterized, unchanged)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'UNKNOWN_STATE', currentStatus: 'REFUNDED' }))
    expect(r.status).toBe('PENDING_ACTIVATION')
    expect(r.reason).toBe('unknown-provider-fallback')
  })

  it('93. REFUNDED + ACTIVE without evidence → PENDING_ACTIVATION (characterized, unchanged)', () => {
    const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'ACTIVE', currentStatus: 'REFUNDED', dataUsedMB: 0, activatedAt: null }))
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('94. REFUNDED + provider FAILED → FAILED (engine does not treat REFUNDED as terminal; unchanged)', () => {
    expect(deriveEsimLifecycleStatus(input({ providerNormalizedStatus: 'FAILED', currentStatus: 'REFUNDED' })).status).toBe('FAILED')
  })

  // ── Invariant 6: the engine never emits PROCESSING ──────
  it('95. engine never outputs PROCESSING for any current/provider combination', () => {
    const currents = ['PENDING', 'PROCESSING', 'PENDING_ACTIVATION', 'INSTALLED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']
    const providers = ['PENDING', 'PROCESSING', 'PROVISIONING', 'QUEUED', 'RESERVED', 'ACTIVE', 'INSTALLED', 'IN_USE', 'ONLINE', 'ATTACHED', 'SUSPENDED', 'DISABLED', 'EXPIRED', 'EXPIRING', 'FAILED', 'ERROR', 'REJECTED', 'CANCELLED', 'CANCELED', 'SOMETHING_NEW']
    for (const current of currents) {
      for (const provider of providers) {
        const r = deriveEsimLifecycleStatus(input({ providerNormalizedStatus: provider, currentStatus: current }))
        expect(r.status).not.toBe('PROCESSING')
      }
    }
  })
})
