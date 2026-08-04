import { describe, it, expect } from 'vitest'
import { deriveOperationalState, deriveWalletOperationalSummary, deriveFulfillmentOperationalSummary } from './operational-classifier'

describe('deriveOperationalState', () => {
  it('1. normal fulfilled order → INFO', () => {
    const s = deriveOperationalState({ orderStatus: 'FULFILLED', orderAgeMinutes: 5, fulfilledQuantity: 1, requestedQuantity: 1, esimCount: 1, walletState: 'CAPTURED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('INFO')
  })

  it('2. partial order → WARNING', () => {
    const s = deriveOperationalState({ orderStatus: 'PARTIALLY_FULFILLED', orderAgeMinutes: 10, fulfilledQuantity: 3, requestedQuantity: 5, esimCount: 3, walletState: 'PARTIALLY_CAPTURED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('WARNING')
    expect(s.title).toBe('Partially Fulfilled')
  })

  it('3. reconciliation order → ERROR', () => {
    const s = deriveOperationalState({ orderStatus: 'PROVIDER_RECONCILIATION', orderAgeMinutes: 60, fulfilledQuantity: 0, requestedQuantity: 1, esimCount: 0, walletState: 'RESERVED', walletAlerts: [], maxRetries: 5, retryCount: 2, isReconciling: true, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('ERROR')
    expect(s.actionType).toBe('RECONCILE')
  })

  it('4. wallet integrity alert → CRITICAL', () => {
    const s = deriveOperationalState({ orderStatus: 'FULFILLED', orderAgeMinutes: 5, fulfilledQuantity: 1, requestedQuantity: 1, esimCount: 0, walletState: 'INTEGRITY_ALERT', walletAlerts: ['Capture without eSIM'], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('CRITICAL')
    expect(s.actionType).toBe('WALLET_REVIEW')
  })

  it('5. fulfillment inconsistency → CRITICAL', () => {
    const s = deriveOperationalState({ orderStatus: 'FULFILLED', orderAgeMinutes: 5, fulfilledQuantity: 6, requestedQuantity: 5, esimCount: 6, walletState: 'CAPTURED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('CRITICAL')
  })

  it('6. provider success + local FAILED → CRITICAL', () => {
    const s = deriveOperationalState({ orderStatus: 'FAILED', orderAgeMinutes: 30, fulfilledQuantity: 1, requestedQuantity: 1, esimCount: 0, walletState: 'RELEASED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: true })
    expect(s.severity).toBe('CRITICAL')
  })

  it('7. retry scheduled → WARNING', () => {
    const s = deriveOperationalState({ orderStatus: 'FAILED', orderAgeMinutes: 10, fulfilledQuantity: 0, requestedQuantity: 1, esimCount: 0, walletState: 'RELEASED', walletAlerts: [], maxRetries: 5, retryCount: 1, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('WARNING')
  })

  it('8. max retries reached → ERROR', () => {
    const s = deriveOperationalState({ orderStatus: 'FAILED', orderAgeMinutes: 60, fulfilledQuantity: 0, requestedQuantity: 1, esimCount: 0, walletState: 'RELEASED', walletAlerts: [], maxRetries: 5, retryCount: 5, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('ERROR')
  })

  it('9. dead-letter callback → ERROR', () => {
    const s = deriveOperationalState({ orderStatus: 'FULFILLED', orderAgeMinutes: 5, fulfilledQuantity: 1, requestedQuantity: 1, esimCount: 1, walletState: 'CAPTURED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: true, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('ERROR')
  })

  it('10. unprocessed webhook → ERROR', () => {
    const s = deriveOperationalState({ orderStatus: 'FULFILLED', orderAgeMinutes: 5, fulfilledQuantity: 1, requestedQuantity: 1, esimCount: 1, walletState: 'CAPTURED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: true, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('ERROR')
  })

  it('11. stale order → ERROR', () => {
    const s = deriveOperationalState({ orderStatus: 'PENDING_PROVIDER', orderAgeMinutes: 60, fulfilledQuantity: 0, requestedQuantity: 1, esimCount: 0, walletState: 'RESERVED', walletAlerts: [], maxRetries: 5, retryCount: 0, isReconciling: false, isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false })
    expect(s.severity).toBe('ERROR')
  })
})

describe('deriveWalletOperationalSummary', () => {
  it('12. normal reserve + capture → CAPTURED', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10 }, { type: 'WALLET_CAPTURE', amount: 10 }], orderStatus: 'FULFILLED', fulfilledQuantity: 1, esimCount: 1 })
    expect(s.state).toBe('CAPTURED')
    expect(s.alerts).toHaveLength(0)
  })

  it('13. capture + release exceeds reserve → INTEGRITY_ALERT', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10 }, { type: 'WALLET_CAPTURE', amount: 8 }, { type: 'WALLET_RELEASE', amount: 5 }], orderStatus: 'FAILED', fulfilledQuantity: 0, esimCount: 0 })
    expect(s.state).toBe('INTEGRITY_ALERT')
    expect(s.alerts.length).toBeGreaterThan(0)
  })

  it('14. refund > capture → INTEGRITY_ALERT', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10 }, { type: 'WALLET_CAPTURE', amount: 5 }, { type: 'WALLET_REFUND', amount: 8 }], orderStatus: 'REFUNDED', fulfilledQuantity: 0, esimCount: 0 })
    expect(s.state).toBe('INTEGRITY_ALERT')
  })

  it('15. capture without eSIM → INTEGRITY_ALERT', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10 }, { type: 'WALLET_CAPTURE', amount: 10 }], orderStatus: 'FULFILLED', fulfilledQuantity: 0, esimCount: 0 })
    expect(s.state).toBe('INTEGRITY_ALERT')
  })

  it('16. FULFILLED without capture → alert', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10 }], orderStatus: 'FULFILLED', fulfilledQuantity: 1, esimCount: 1 })
    expect(s.alerts.length).toBeGreaterThan(0)
  })

  it('17. Decimal arithmetic correct (reserve 10.50, capture 10.50)', () => {
    const s = deriveWalletOperationalSummary({ transactions: [{ type: 'WALLET_RESERVE', amount: -10.5 }, { type: 'WALLET_CAPTURE', amount: 10.5 }], orderStatus: 'FULFILLED', fulfilledQuantity: 1, esimCount: 1 })
    expect(s.totalCaptured).toBeCloseTo(10.5)
    expect(s.state).toBe('CAPTURED')
  })
})

describe('deriveFulfillmentOperationalSummary', () => {
  it('18. requested 5, fulfilled 3 → PARTIAL', () => {
    const s = deriveFulfillmentOperationalSummary({ requestedQuantity: 5, fulfilledQuantity: 3, failedQuantity: 0, esimCount: 3 })
    expect(s.state).toBe('PARTIAL')
    expect(s.percentage).toBe(60)
    expect(s.remainingQuantity).toBe(2)
  })

  it('19. requested 5, fulfilled 5 → COMPLETE', () => {
    const s = deriveFulfillmentOperationalSummary({ requestedQuantity: 5, fulfilledQuantity: 5, failedQuantity: 0, esimCount: 5 })
    expect(s.state).toBe('COMPLETE')
  })

  it('20. fulfilled > requested → INCONSISTENT', () => {
    const s = deriveFulfillmentOperationalSummary({ requestedQuantity: 3, fulfilledQuantity: 5, failedQuantity: 0, esimCount: 5 })
    expect(s.state).toBe('INCONSISTENT')
  })

  it('21. no fulfillment → NOT_STARTED', () => {
    const s = deriveFulfillmentOperationalSummary({ requestedQuantity: 5, fulfilledQuantity: 0, failedQuantity: 0, esimCount: 0 })
    expect(s.state).toBe('NOT_STARTED')
  })
})
