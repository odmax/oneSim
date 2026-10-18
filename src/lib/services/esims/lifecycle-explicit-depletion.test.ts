import { describe, it, expect } from 'vitest'
import { deriveEsimLifecycleStatus, EXHAUSTED_PROVIDER_STATUSES } from './lifecycle-status'

/**
 * Explicit provider DEPLETED-status normalization through the canonical
 * lifecycle engine — covers providers WITHOUT usage lookup (AirHub/iBASIS)
 * that report exhaustion via status sync / webhooks / reconciliation.
 *
 * The engine never returns providerStatus (the callers persist the raw provider
 * value separately) — here we fix the canonical customer-visible `status`.
 */
function derive(input: { provider?: string; current?: string; dataUsedMB?: number; activatedAt?: boolean }) {
  return deriveEsimLifecycleStatus({
    providerNormalizedStatus: input.provider || 'UNKNOWN',
    currentStatus: input.current || 'PENDING_ACTIVATION',
    dataUsedMB: input.dataUsedMB ?? 0,
    activatedAt: input.activatedAt ? new Date() : null,
  })
}

describe('explicit provider exhausted status → DEPLETED (AirHub/iBASIS path)', () => {
  it('EXHAUSTED provider status converts ACTIVE current → DEPLETED', () => {
    const r = derive({ provider: 'EXHAUSTED', current: 'ACTIVE', activatedAt: true })
    expect(r.status).toBe('DEPLETED')
  })

  it('all four exhausted labels normalize to DEPLETED', () => {
    for (const s of EXHAUSTED_PROVIDER_STATUSES) {
      expect(derive({ provider: s, current: 'PENDING_ACTIVATION' }).status).toBe('DEPLETED')
    }
  })

  it('SUSPENDED current converts to DEPLETED on explicit exhaustion', () => {
    expect(derive({ provider: 'EXHAUSTED', current: 'SUSPENDED' }).status).toBe('DEPLETED')
  })

  it('EXPIRED + provider EXHAUSTED remains EXPIRED (precedence)', () => {
    expect(derive({ provider: 'EXHAUSTED', current: 'EXPIRED' }).status).toBe('EXPIRED')
  })

  it('FAILED / CANCELLED / REFUNDED + provider EXHAUSTED remain unchanged', () => {
    for (const s of ['FAILED', 'CANCELLED', 'REFUNDED']) {
      expect(derive({ provider: 'EXHAUSTED', current: s }).status).toBe(s)
    }
  })

  it('already-DEPLETED + provider EXHAUSTED stays DEPLETED (idempotent)', () => {
    expect(derive({ provider: 'EXHAUSTED', current: 'DEPLETED' }).status).toBe('DEPLETED')
  })

  it('generic ACTIVE provider status never rebuilds DEPLETED (top-up reactivation safety)', () => {
    expect(derive({ provider: 'ACTIVE', current: 'DEPLETED', activatedAt: true }).status).toBe('DEPLETED')
  })

  it('device-installed signal never rebuilds DEPLETED', () => {
    const r = deriveEsimLifecycleStatus({
      providerNormalizedStatus: 'INSTALLED',
      currentStatus: 'DEPLETED',
      dataUsedMB: 0,
      activatedAt: new Date(),
      providerInstalledSignal: true,
    })
    expect(r.status).toBe('DEPLETED')
  })

  it('unknown provider status preserves DEPLETED (safe fallback)', () => {
    expect(derive({ provider: 'SOMETHING_NEW', current: 'DEPLETED', activatedAt: true }).status).toBe('DEPLETED')
  })

  it('unknown provider status preserves ACTIVE (existing safe behaviour)', () => {
    expect(derive({ provider: 'SOMETHING_NEW', current: 'ACTIVE', activatedAt: true }).status).toBe('ACTIVE')
  })

  it('provider EXPIRED overrides DEPLETED', () => {
    expect(derive({ provider: 'EXPIRED', current: 'DEPLETED' }).status).toBe('EXPIRED')
  })
})