import { describe, it, expect } from 'vitest'
import {
  deriveDepletionStatus,
  isProviderExhaustedStatus,
  EXHAUSTED_PROVIDER_STATUSES,
} from './lifecycle-status'
import { getEsimStatusLabel, getEsimActionAvailability, isTopUpEligibleStatus, TOP_UP_ELIGIBLE_STATUSES } from '@/lib/providers/capabilities/esim-action-availability'
import { orderStatusLabel } from '@/lib/status-labels'
import { TERMINAL_TOP_UP_STATUSES } from '@/lib/providers/capabilities/esim-action-availability'

/**
 * Provider-neutral DEPLETED status — canonical derivation + presentation.
 * Cases map 1:1 to the acceptance tests:
 *  1 remaining=0 -> DEPLETED
 *  2 remaining<0 (clamped safe) -> DEPLETED
 *  3 remaining=null -> no DEPLETED
 *  4 missing usage -> no DEPLETED
 *  5 usage failure -> preserve existing status (no evidence -> null)
 *  6 ACTIVE provider status + remaining=0 -> DEPLETED (providerStatus preserved separately)
 *  7 explicit EXHAUSTED provider status -> DEPLETED
 *  8 EXPIRED remains EXPIRED even when remaining=0
 *  9 DEPLETED + remaining>0 (authoritative) -> ACTIVE (top-up reactivation)
 * 10 repeated identical sync -> idempotent (no status rewrite)
 * 12 UI label 'Depleted'
 */
describe('deriveDepletionStatus — canonical provider-neutral rule', () => {
  it('1: remaining = 0 on a valid snapshot results in DEPLETED', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: 0, snapshotValid: true })).toBe('DEPLETED')
  })

  it('2: remaining below zero is safe and results in DEPLETED', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: -3.2, snapshotValid: true })).toBe('DEPLETED')
  })

  it('3: remaining = null never results in DEPLETED', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: null, snapshotValid: true })).toBeNull()
  })

  it('4: missing usage (undefined) never results in DEPLETED', () => {
    expect(deriveDepletionStatus('INSTALLED', { dataRemainingMB: undefined, snapshotValid: true })).toBeNull()
  })

  it('5: an invalid/stale snapshot never results in DEPLETED', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: 0, snapshotValid: false })).toBeNull()
  })

  it('6: ACTIVE-provider row with remaining 0 -> DEPLETED (providerStatus kept separate)', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: 0, snapshotValid: true })).toBe('DEPLETED')
    expect(isProviderExhaustedStatus('ACTIVE')).toBe(false)
  })

  it('7: explicit exhausted provider status normalizes to DEPLETED', () => {
    for (const s of EXHAUSTED_PROVIDER_STATUSES) {
      expect(isProviderExhaustedStatus(s)).toBe(true)
      expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: undefined, providerExhausted: true })).toBe('DEPLETED')
    }
  })

  it('8: EXPIRED stays EXPIRED even when remaining = 0', () => {
    expect(deriveDepletionStatus('EXPIRED', { dataRemainingMB: 0, snapshotValid: true })).toBeNull()
    expect(deriveDepletionStatus('EXPIRED', { providerExhausted: true })).toBeNull()
    // FAILED / CANCELLED / REFUNDED are terminal, never DEPLETED
    for (const s of ['FAILED', 'CANCELLED', 'REFUNDED']) {
      expect(deriveDepletionStatus(s, { dataRemainingMB: 0, snapshotValid: true })).toBeNull()
    }
  })

  it('9: DEPLETED with authoritative remaining > 0 returns to ACTIVE (top-up reactivation)', () => {
    expect(deriveDepletionStatus('DEPLETED', { dataRemainingMB: 512, snapshotValid: true })).toBe('ACTIVE')
    // but never from an unverified top-up alone
    expect(deriveDepletionStatus('DEPLETED', { dataRemainingMB: 512, snapshotValid: false })).toBeNull()
  })

  it('10: repeated identical sync is idempotent (no status rewrite)', () => {
    expect(deriveDepletionStatus('DEPLETED', { dataRemainingMB: 0, snapshotValid: true })).toBeNull()
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: 100, snapshotValid: true })).toBeNull()
  })

  it('never infers DEPLETED from total allowance or remaining-only-without-snapshot', () => {
    expect(deriveDepletionStatus('ACTIVE', { dataRemainingMB: 0, snapshotValid: undefined })).toBeNull()
  })
})

describe('REFUNDED terminal precedence in depletion derivation', () => {
  it('REFUNDED + remaining data zero remains REFUNDED (never DEPLETED)', () => {
    expect(deriveDepletionStatus('REFUNDED', { dataRemainingMB: 0, snapshotValid: true })).toBeNull()
  })

  it('REFUNDED + explicit exhausted provider status remains REFUNDED (never DEPLETED)', () => {
    expect(deriveDepletionStatus('REFUNDED', { providerExhausted: true })).toBeNull()
  })

  it('REFUNDED + remaining data positive remains REFUNDED (never ACTIVE/replenished)', () => {
    expect(deriveDepletionStatus('REFUNDED', { dataRemainingMB: 512, snapshotValid: true })).toBeNull()
  })
})

describe('presentation and eligibility', () => {
  it('12: UI status label returns "Depleted" with danger tone', () => {
    expect(getEsimStatusLabel('DEPLETED')).toEqual({ label: 'Depleted', tone: 'danger' })
    expect(orderStatusLabel('DEPLETED').label).toBe('Depleted')
  })

  it('unknown statuses do not accidentally become depleted labels', () => {
    expect(getEsimStatusLabel('ACTIVE').label).toBe('Active')
  })

  it('11: DEPLETED remains top-up eligible (not terminal)', () => {
    expect(TERMINAL_TOP_UP_STATUSES).not.toContain('DEPLETED')
  })
})

describe('DEPLETED top-up availability — canonical status eligibility', () => {
  function capProvider(over: Record<string, any> = {}): any {
    return { id: 'p1', name: 'T', type: 'GENERIC', code: 'TELNA', capabilities: ['TOP_UP'], enabledCapabilities: ['TOP_UP'], supportsTopUp: true, supportsQRCode: null, ...over }
  }

  const capEsim = (status: string): any => ({
    iccid: '89012345678901234567', imsi: null, activationCode: null, qrCodeUrl: null, providerResponse: null,
    providerActivationId: null, providerSubscriptionId: null, providerSubscriberId: null,
    dataTotalMB: 500, dataRemainingMB: 0, status,
  })

  it('DEPLETED + provider supports top-up => allowed', () => {
    expect(isTopUpEligibleStatus('DEPLETED')).toBe(true)
    expect(TOP_UP_ELIGIBLE_STATUSES).toContain('DEPLETED')
    const a = getEsimActionAvailability({ provider: capProvider(), esim: capEsim('DEPLETED') })
    expect(a.topUp.visible).toBe(true)
    expect(a.topUp.enabled).toBe(true)
  })

  it('DEPLETED + provider does not support top-up => blocked', () => {
    const a = getEsimActionAvailability({ provider: capProvider({ supportsTopUp: false }), esim: capEsim('DEPLETED') })
    expect(a.topUp.enabled).toBe(false)
  })

  it('terminal / expired statuses remain blocked for top-up', () => {
    for (const s of ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']) {
      expect(isTopUpEligibleStatus(s)).toBe(false)
      const a = getEsimActionAvailability({ provider: capProvider(), esim: capEsim(s) })
      expect(a.topUp.enabled).toBe(false)
    }
    expect(TOP_UP_ELIGIBLE_STATUSES.length).toBe(4) // ACTIVE, PENDING_ACTIVATION, PENDING, DEPLETED only
  })

  it('not every status becomes eligible', () => {
    expect(isTopUpEligibleStatus('SUSPENDED')).toBe(false)
    expect(isTopUpEligibleStatus('PROCESSING')).toBe(false)
    expect(isTopUpEligibleStatus('INSTALLED')).toBe(false)
  })
})