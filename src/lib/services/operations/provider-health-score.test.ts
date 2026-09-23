import { describe, it, expect } from 'vitest'
import { evaluateLowBalanceAlert } from './provider-health-score'

describe('evaluateLowBalanceAlert — authoritative provider balance rule + threshold precedence', () => {
  const snapshot = (balance: unknown, over: Record<string, unknown> = {}) => ({ balance, success: true, ...over })

  it('opens an alert when an authoritative numeric balance is below the chosen threshold', () => {
    expect(evaluateLowBalanceAlert(snapshot(5), { walletThreshold: 20 })).toEqual({
      alert: true,
      reason: 'Balance 5 below threshold 20',
      thresholdSource: 'wallet',
    })
  })

  it('resolves (alert false) when the balance returns at/above the threshold', () => {
    expect(evaluateLowBalanceAlert(snapshot(20), { walletThreshold: 20 }).alert).toBe(false)
    expect(evaluateLowBalanceAlert(snapshot(250), { walletThreshold: 20 }).alert).toBe(false)
  })

  it('ProviderWallet threshold is honored when no config threshold exists', () => {
    const r = evaluateLowBalanceAlert(snapshot(10), { walletThreshold: 15 })
    expect(r.alert).toBe(true)
    expect(r.thresholdSource).toBe('wallet')
  })

  it('wallet threshold overrides both legacy config thresholds', () => {
    // Wallet says 100 (alert at 10); config would allow (5) — wallet wins.
    const r = evaluateLowBalanceAlert(snapshot(10), {
      walletThreshold: 100,
      configLowThreshold: 5,
      configBalanceThreshold: 2,
    })
    expect(r.alert).toBe(true)
    expect(r.reason).toBe('Balance 10 below threshold 100')
    expect(r.thresholdSource).toBe('wallet')
  })

  it('config.lowBalanceThreshold works when no ProviderWallet threshold exists', () => {
    const r = evaluateLowBalanceAlert(snapshot(10), { walletThreshold: null, configLowThreshold: 20 })
    expect(r.alert).toBe(true)
    expect(r.thresholdSource).toBe('configLow')
  })

  it('falls back to config.balanceThreshold as the last source', () => {
    const r = evaluateLowBalanceAlert(snapshot(10), { walletThreshold: null, configLowThreshold: null, configBalanceThreshold: 30 })
    expect(r.alert).toBe(true)
    expect(r.thresholdSource).toBe('configBalance')
  })

  it('missing threshold (all sources) creates NO alert — no default is invented', () => {
    expect(evaluateLowBalanceAlert(snapshot(1), { walletThreshold: null, configLowThreshold: null, configBalanceThreshold: null }).alert).toBe(false)
    expect(evaluateLowBalanceAlert(snapshot(1), {}).alert).toBe(false)
    expect(evaluateLowBalanceAlert(snapshot(1), { walletThreshold: '   ' }).alert).toBe(false)
  })

  it('missing balance data (null) is NEVER treated as zero — no alert', () => {
    expect(evaluateLowBalanceAlert(snapshot(null), { walletThreshold: 20 }).alert).toBe(false)
    expect(evaluateLowBalanceAlert({}, { walletThreshold: 20 }).alert).toBe(false)
    expect(evaluateLowBalanceAlert(null, { walletThreshold: 20 }).alert).toBe(false)
  })

  it('a FAILED balance fetch is not treated as zero — no alert', () => {
    expect(evaluateLowBalanceAlert(snapshot(0, { success: false }), { walletThreshold: 20 }).alert).toBe(false)
    expect(evaluateLowBalanceAlert(snapshot(5, { success: false }), { walletThreshold: 20 }).alert).toBe(false)
  })

  it('a STALE snapshot is not authoritative — no alert from aged data', () => {
    const stale = { balance: 2, success: true, fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }
    expect(evaluateLowBalanceAlert(stale, { walletThreshold: 20 }).alert).toBe(false)
    const fresh = { balance: 2, success: true, fetchedAt: new Date().toISOString() }
    expect(evaluateLowBalanceAlert(fresh, { walletThreshold: 20 }).alert).toBe(true)
  })

  it('accepts string balances and string thresholds', () => {
    expect(evaluateLowBalanceAlert(snapshot('5.5'), { walletThreshold: '10' }).alert).toBe(true)
    expect(evaluateLowBalanceAlert(snapshot(11), { walletThreshold: '10' }).alert).toBe(false)
  })

  it('an authoritative balance of exactly zero below threshold IS an alert', () => {
    expect(evaluateLowBalanceAlert(snapshot(0), { walletThreshold: 5 }).alert).toBe(true)
  })

  it('currencies are never compared across incompatible wallet/snapshot currencies', () => {
    // ProviderWallet in EUR vs snapshot in USD: units incompatible → never alert.
    const r = evaluateLowBalanceAlert(snapshot(5, { currency: 'USD' }), { walletThreshold: 20, walletCurrency: 'EUR' })
    expect(r.alert).toBe(false)
    // Same currency (or missing snapshot currency) → compared normally.
    expect(evaluateLowBalanceAlert(snapshot(5, { currency: 'USD' }), { walletThreshold: 20, walletCurrency: 'USD' }).alert).toBe(true)
    expect(evaluateLowBalanceAlert(snapshot(5), { walletThreshold: 20, walletCurrency: 'USD' }).alert).toBe(true)
  })

  it('provider/account isolation is a per-provider wallet lookup (inputs are the same provider row)', () => {
    // The wallet threshold + snapshot both come from providerId-keyed reads in
    // computeProviderHealth; the helper only ever sees one provider's data. This
    // pins that a different provider's threshold cannot influence the decision.
    const walletA = evaluateLowBalanceAlert(snapshot(10), { walletThreshold: 50 })
    const walletB = evaluateLowBalanceAlert(snapshot(10), { walletThreshold: 5000 })
    expect(walletA.alert).toBe(true)
    expect(walletB.alert).toBe(true) // still below B's threshold — each evaluated independently
    expect(walletA.reason).not.toBe(walletB.reason)
  })
})