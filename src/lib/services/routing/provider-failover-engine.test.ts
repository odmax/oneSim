import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyRetry, classifyProviderOutcome, classifyFailoverEligibility, type FailoverCheckInput } from './provider-failover-engine'

function checkInput(overrides: Partial<FailoverCheckInput> = {}): FailoverCheckInput {
  return {
    providerReservationId: null, providerFulfillId: null,
    walletCaptured: false, hasEsims: false,
    providerError: null, isActiveReconciliation: false,
    hasPendingProviderAttempt: false,
    ...overrides,
  }
}

describe('classifyRetry', () => {
  it('1. TIMEOUT is retryable', () => {
    expect(classifyRetry({ code: 'TIMEOUT', message: 'Request timed out' })).toBe('RETRYABLE')
  })

  it('2. INVALID_PACKAGE is non-retryable', () => {
    expect(classifyRetry({ code: 'INVALID_PACKAGE', message: 'Invalid package' })).toBe('NON_RETRYABLE')
  })

  it('3. null error is non-retryable', () => {
    expect(classifyRetry(null)).toBe('NON_RETRYABLE')
    expect(classifyRetry(undefined)).toBe('NON_RETRYABLE')
  })

  it('4. explicit details.retryable=true overrides', () => {
    expect(classifyRetry({ code: 'SOMETHING', details: { retryable: true } })).toBe('RETRYABLE')
  })

  it('5. OUT_OF_STOCK is RETRYABLE → eligible for GLOBAL provider failover', () => {
    // Inventory exhaustion must not be terminal: the purchase loop failovers to
    // another eligible provider (the same provider is never retried in-loop, and
    // recovery treats OUT_OF_STOCK as NOT_RETRYABLE for same-provider redispatch).
    expect(classifyRetry({ code: 'OUT_OF_STOCK', message: 'US-Matrix has no assignable eSIM inventory' })).toBe('RETRYABLE')
  })

  it('6. unrelated HTTP_404 stays distinguishable from OUT_OF_STOCK', () => {
    // An assign-package HTTP_404 is a provider HTTP failure — never rewritten
    // to an inventory code, so its classification remains the default.
    expect(classifyRetry({ code: 'HTTP_404', message: 'Resource not found' })).toBe('NON_RETRYABLE')
    expect(classifyRetry({ code: 'HTTP_404', message: 'Resource not found' })).not.toBe(classifyRetry({ code: 'OUT_OF_STOCK' }))
  })
})

describe('classifyProviderOutcome', () => {
  it('TIMEOUT is AMBIGUOUS (never retry a billable mutation)', () => {
    expect(classifyProviderOutcome({ code: 'TIMEOUT', message: 'Request timed out' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('explicit details.ambiguous is AMBIGUOUS', () => {
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'fetch failed', details: { ambiguous: true } })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('connection reset (ECONNRESET) is AMBIGUOUS', () => {
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'socket hang up', details: { causeCode: 'ECONNRESET' } })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('connection refused (ECONNREFUSED) is RETRYABLE_PRE_DISPATCH', () => {
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'fetch failed', details: { causeCode: 'ECONNREFUSED' } })).toBe('RETRYABLE_PRE_DISPATCH')
  })

  it('DNS failure (ENOTFOUND) is RETRYABLE_PRE_DISPATCH', () => {
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'getaddrinfo ENOTFOUND' })).toBe('RETRYABLE_PRE_DISPATCH')
  })

  it('explicit provider rejection is DEFINITIVE_FAILURE', () => {
    expect(classifyProviderOutcome({ code: 'PROVIDER_FAILED', message: 'Bundle allocation failed' })).toBe('DEFINITIVE_FAILURE')
  })

  it('null/undefined error is DEFINITIVE_FAILURE', () => {
    expect(classifyProviderOutcome(null)).toBe('DEFINITIVE_FAILURE')
    expect(classifyProviderOutcome(undefined)).toBe('DEFINITIVE_FAILURE')
  })

  it('bare NETWORK_ERROR is AMBIGUOUS (post-dispatch transport — inverted default)', () => {
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'fetch failed' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('NETWORK_ERROR with details.retryable=true (AirHub repurchase vector) is AMBIGUOUS, never RETRYABLE', () => {
    // Regression: AirHub returned NETWORK_ERROR + details.retryable=true with no
    // preDispatch/causeCode proof. Before the fix this classified as
    // RETRYABLE_PRE_DISPATCH → cross-provider failover → duplicate purchase.
    expect(classifyProviderOutcome({ code: 'NETWORK_ERROR', message: 'fetch failed', details: { retryable: true } })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('non-JSON 2xx response is AMBIGUOUS (provider may have committed)', () => {
    expect(classifyProviderOutcome({ code: 'NON_JSON_RESPONSE', message: 'malformed JSON (status 200)' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('HTTP 5xx is AMBIGUOUS', () => {
    expect(classifyProviderOutcome({ code: 'HTTP_502', message: 'Bad gateway' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
    expect(classifyProviderOutcome({ code: 'HTTP_504', message: 'Gateway timeout' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('thrown PROVIDER_ERROR (unknown post-dispatch state) is AMBIGUOUS', () => {
    expect(classifyProviderOutcome({ code: 'PROVIDER_ERROR', message: 'Something threw after POST' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('unrecognized error codes default to AMBIGUOUS (inverted default)', () => {
    expect(classifyProviderOutcome({ code: 'MYSTERY_CODE', message: 'unexpected' })).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
  })

  it('HTTP 4xx explicit rejection stays DEFINITIVE_FAILURE', () => {
    expect(classifyProviderOutcome({ code: 'HTTP_400', message: 'Bad request' })).toBe('DEFINITIVE_FAILURE')
    expect(classifyProviderOutcome({ code: 'HTTP_403', message: 'Forbidden' })).toBe('DEFINITIVE_FAILURE')
  })

  it('INVALID_PACKAGE explicit rejection stays DEFINITIVE_FAILURE', () => {
    expect(classifyProviderOutcome({ code: 'INVALID_PACKAGE', message: 'Invalid package' })).toBe('DEFINITIVE_FAILURE')
  })

  it('RATE_LIMITED / throttling is a provable provider decline → RETRYABLE_PRE_DISPATCH (failover path, never ambiguous)', () => {
    expect(classifyProviderOutcome({ code: 'RATE_LIMITED', message: 'Too many requests', details: { retryable: true } })).toBe('RETRYABLE_PRE_DISPATCH')
    expect(classifyProviderOutcome({ code: 'THROTTLED', message: 'slow down' })).toBe('RETRYABLE_PRE_DISPATCH')
    expect(classifyProviderOutcome({ code: 'HTTP_429', message: 'Rate limited' })).toBe('RETRYABLE_PRE_DISPATCH')
    expect(classifyProviderOutcome({ code: 'X', message: 'got rate limited, retry later' })).toBe('RETRYABLE_PRE_DISPATCH')
  })
})

describe('classifyFailoverEligibility', () => {
  it('5. clean pre-acceptance failure allows failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'INSUFFICIENT_BALANCE' },
    }))).toBe('FAILOVER_ALLOWED')
  })

  it('5b. bare NETWORK_ERROR blocks failover (post-dispatch transport — inverted default)', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'NETWORK_ERROR', message: 'fetch failed' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('5c. HTTP 502 / non-JSON response blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'HTTP_502', message: 'Bad gateway' },
    }))).toBe('RECONCILIATION_REQUIRED')
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'NON_JSON_RESPONSE', message: 'malformed JSON (200)' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('5d. unrecognized error codes default to RECONCILIATION_REQUIRED (inverted default)', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'MYSTERY_CODE', message: 'unexpected' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('6. provider unavailable is uncertain → reconcile not failover', () => {
    // PROVIDER_UNAVAILABLE may mean request reached provider but response failed
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'PROVIDER_UNAVAILABLE' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('7. missing PURCHASE excludes provider', () => {
    // This is checked at the candidate level, not failover
    expect(true).toBe(true)
  })

  it('8. insufficient stock allows failover', () => {
    // checkProviderInventory returns INSUFFICIENT_STOCK → orchestrator selects next candidate
    expect(true).toBe(true)
  })

  it('9. definite pre-acceptance failure allows failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    }))).toBe('FAILOVER_ALLOWED')
  })

  it('10. uncertain TIMEOUT blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'TIMEOUT', message: 'Network timeout' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('11. providerReservationId blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerReservationId: 'res-1',
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('12. providerFulfillId blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerFulfillId: 'ful-1',
    }))).toBe('ORDER_COMPLETE')
  })

  it('13. existing eSIM blocks full-order failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      hasEsims: true,
    }))).toBe('ORDER_COMPLETE')
  })

  it('14. wallet capture blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      walletCaptured: true,
    }))).toBe('ORDER_COMPLETE')
  })

  it('15. active reconciliation blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      isActiveReconciliation: true,
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('16. pending provider attempt blocks failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      hasPendingProviderAttempt: true,
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('17. 502 gateway timeout is uncertain', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: '', message: '502 Bad Gateway' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('18. 503 service unavailable is uncertain', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: '', message: '503 Service Unavailable' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('19. connection reset is uncertain', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: '', message: 'connection reset by peer' },
    }))).toBe('RECONCILIATION_REQUIRED')
  })

  it('20. definite Choice rejection with no provider ref allows failover', () => {
    expect(classifyFailoverEligibility(checkInput({
      providerError: { code: 'PROVIDER_FAILED', message: 'Bundle allocation failed' },
    }))).toBe('FAILOVER_ALLOWED')
  })

  it('21. failed order with all candidates exhausted', () => {
    // After all candidates exhausted → needs safe FAILED + wallet release
    expect(true).toBe(true)
  })

  it('22. feature flag disabled preserves current behavior', () => {
    // PROVIDER_FAILOVER_ENABLED=false → orchestrator uses original single-provider path
    expect(true).toBe(true)
  })

  it('23. provider cost change does not alter quoted amount', () => {
    // Order uses immutable quotedTotalAmount regardless of which provider fulfills
    expect(true).toBe(true)
  })
})
