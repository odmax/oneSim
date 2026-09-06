import { describe, it, expect } from 'vitest'
import { classifyProviderOutcome, classifyRetry } from './provider-failover-engine'

// Provider-specific regression: the actual connector-level error contracts must
// route through the central classifier to AMBIGUOUS_PROVIDER_OUTCOME — never
// RETRYABLE_PRE_DISPATCH (cross-provider failover) and never DEFINITIVE_FAILURE
// (blind wallet release). Each shape below is copied verbatim from the current
// connector source, not invented.
describe('provider-specific ambiguous-outcome routing regression (Choice / iBASIS / USMatrix)', () => {
  describe('Choice (url-token connector family)', () => {
    it('Choice add-bundle-from-pool request timed out → AMBIGUOUS, never failover-eligible', () => {
      // url-token-connector.ts:79 — fetchText AbortError shape.
      const err = { code: 'TIMEOUT', message: 'Request timed out', details: { ambiguous: true, causeCode: 'ABORT' } }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(classifyProviderOutcome(err)).not.toBe('RETRYABLE_PRE_DISPATCH')
      expect(classifyProviderOutcome(err)).not.toBe('DEFINITIVE_FAILURE')
    })

    it('Choice accepted purchase with no ICCID → AMBIGUOUS and NON_RETRYABLE (reconcile, never re-purchase)', () => {
      // url-token-connector.ts:861-868 — ambiguous NO_ICCIDS with upstream proof.
      const err = {
        code: 'NO_ICCIDS',
        message: 'Provider accepted the purchase but returned no ICCID — outcome is ambiguous and requires reconciliation',
        details: { retryable: false, ambiguous: true, upstreamConfirmed: true, providerOrderId: 'txn-choice-8891' },
      }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(classifyRetry(err)).toBe('NON_RETRYABLE')
    })

    it('Choice generic network failure → AMBIGUOUS via details.ambiguous', () => {
      // url-token-connector.ts:84 — fetchText non-AbortError shape.
      const err = { code: 'NETWORK_ERROR', message: 'fetch failed', details: { ambiguous: true, causeCode: 'ECONNRESET' } }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
    })
  })

  describe('iBASIS (reseller-gateway connector family)', () => {
    it('iBASIS buy request timed out → AMBIGUOUS, not FAILED, not failover', () => {
      // ibasis-connector.ts:312-314 raw TIMEOUT, normalized at :166 to NETWORK_ERROR.
      const err = { code: 'NETWORK_ERROR', message: 'iBASIS request timed out after 15000ms' }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(classifyProviderOutcome(err)).not.toBe('RETRYABLE_PRE_DISPATCH')
      expect(classifyProviderOutcome(err)).not.toBe('DEFINITIVE_FAILURE')
    })

    it('iBASIS generic transport failure → AMBIGUOUS (post-dispatch, unknown commit)', () => {
      // ibasis-connector.ts:320 — non-DNS, non-refused request failure.
      const err = { code: 'NETWORK_ERROR', message: 'iBASIS request failed: fetch failed' }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
    })
  })

  describe('USMatrix (usmatrix connector)', () => {
    it('USMatrix assign-package request timed out → AMBIGUOUS', () => {
      // usmatrix-connector.ts:214-215 — request AbortError shape.
      const err = { code: 'TIMEOUT', message: 'Request timed out' }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(classifyProviderOutcome(err)).not.toBe('RETRYABLE_PRE_DISPATCH')
    })

    it('USMatrix assign-package network failure → AMBIGUOUS, never failover-eligible', () => {
      // usmatrix-connector.ts:214-215 — request catch shape.
      const err = { code: 'NETWORK_ERROR', message: 'US-Matrix request failed: fetch failed' }
      expect(classifyProviderOutcome(err)).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(classifyProviderOutcome(err)).not.toBe('RETRYABLE_PRE_DISPATCH')
    })
  })
})