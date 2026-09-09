import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * iBASIS contract-safety invariants — source-level guards. Deterministic: reads
 * sources only; never executes a connector and never touches DB/provider.
 *
 * Guarantees:
 *  1. iBASIS `completed` maps to the canonical `COMPLETED` status (already a
 *     FOUND_SUCCESS value in the shared reconciliation engine) — NOT the
 *     `READY_TO_INSTALL` value, which the shared engine does not recognize.
 *  2. The canonical purchase (activateESIM), provider-operation finalizer,
 *     reconciliation, and recovery never import the deprecated iBASIS admin
 *     sync actions (ibasis-sim-sync / ibasis-subscriber-sync /
 *     ibasis-subscription-sync) — those paths use the connector + shared
 *     services only.
 *  3. The async provider-operation finalize step is ICCID-gated (COMPLETED /
 *     ACTIVE / ACTIVATED without an ICCID → reconciliation; activationCode
 *     alone can never finalize).
 *  4. Reconciliation never calls a provider purchase mutation.
 */

function readConnector(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/ibasis-connector.ts'), 'utf8')
}

function readMapper(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/mappers/ibasis-subscription-mapper.ts'), 'utf8')
}

function readOperationHandler(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/jobs/handlers/provider-operation.ts'), 'utf8')
}

function readReconciliation(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/reconciliation.ts'), 'utf8')
}

function readAttemptService(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/provider-attempt-service.ts'), 'utf8')
}

describe('iBASIS completed → canonical COMPLETED (reconciliation-safe)', () => {
  const mapper = readMapper()

  it('maps provider completed to COMPLETED (authoritative success), never READY_TO_INSTALL', () => {
    expect(mapper).toContain("completed: 'COMPLETED'")
    expect(mapper).not.toMatch(/completed: 'READY_TO_INSTALL'/)
    // The shared reconciliation engine treats COMPLETED as FOUND_SUCCESS.
    expect(readReconciliation()).toMatch(/\['ACTIVE', 'FULFILLED', 'COMPLETED', 'INSTALLED'\]/)
  })
})

describe('iBASIS canonical purchase/finalization does not depend on deprecated admin sync actions', () => {
  const connector = readConnector()
  const opHandler = readOperationHandler()
  const reconciliation = readReconciliation()
  const attempt = readAttemptService()

  it('ibasis-connector activateESIM/purchase path never imports the deprecated admin sync actions', () => {
    expect(connector).not.toMatch(/ibasis-sim-sync|ibasis-subscriber-sync|ibasis-subscription-sync/)
  })

  it('provider-operation handler, reconciliation, and provider-attempt never import the deprecated admin sync actions', () => {
    for (const src of [opHandler, reconciliation, attempt]) {
      expect(src).not.toMatch(/ibasis-sim-sync|ibasis-subscriber-sync|ibasis-subscription-sync/)
    }
  })

  it('provider-operation finalize is ICCID-gated (activationCode alone can never finalize)', () => {
    expect(opHandler).toContain("['ACTIVE', 'ACTIVATED', 'COMPLETED'].includes(providerStatus)")
    expect(opHandler).toContain('if (providerIccids.length === 0)')
    expect(opHandler).toContain('cannot finalize')
  })

  it('reconciliation still finalizes only via canonical finalizer and never purchases', () => {
    expect(reconciliation).toContain('completeProviderFinalization')
    expect(reconciliation).toContain('hasFulfillmentIdentity')
    expect(reconciliation).not.toMatch(/PurhaseSim|createSubscription|subscriptionActivationsPath/)
  })
})