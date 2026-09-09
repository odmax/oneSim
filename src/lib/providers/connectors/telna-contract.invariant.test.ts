import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Telna contract safety invariants — source-level guards. Deterministic: reads
 * sources only, never executes a connector and never touches the DB/provider.
 *
 * Guarantees:
 *  1. The canonical purchase mutation (createPackage) is issued through the
 *     dedicated `packageCreate` registry entry (mutation:true, POST
 *     /v2.1/pcr/packages) — never through the read-only `packages` list key.
 *  2. The canonical purchase path and the shared provider-attempt/recovery/
 *     reconciliation services NEVER reference the deprecated admin mutation
 *     surface (assignPackageToSim / refreshSimPCRProfile / updateSimPCRProfile),
 *     so fulfillment can never call a provider mutation outside activateESIM.
 *  3. A single purhase dispatch performs exactly one POST /v2.1/pcr/packages.
 */

function readConnector(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/telna-connector.ts'), 'utf8')
}

function readEndpoints(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/telna-endpoints.ts'), 'utf8')
}

function readAttemptService(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/provider-attempt-service.ts'), 'utf8')
}

function readReconciliation(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/reconciliation.ts'), 'utf8')
}

function readRecovery(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/recovery.ts'), 'utf8')
}

describe('Telna purchase mutation contract', () => {
  const connector = readConnector()
  const endpoints = readEndpoints()

  it('createPackage POSTs via the packageCreate registry entry, never the read-only packages key', () => {
    const fn = connector.slice(connector.indexOf('async createPackage('), connector.indexOf('async topUpESIM('))
    expect(fn).toContain("this.request({ endpoint: 'packageCreate', body: req })")
    expect(fn).not.toMatch(/endpoint: 'packages'/)
  })

  it('packageCreate is classified mutation:true, POST; packages list stays read-only', () => {
    const pkgCreate = endpoints.slice(endpoints.indexOf('  packageCreate:'), endpoints.indexOf('  packageCreate:') + 260)
    expect(pkgCreate).toContain("method: 'POST'")
    expect(pkgCreate).toContain('mutation: true')
    const pkgList = endpoints.slice(endpoints.indexOf('  packages:'), endpoints.indexOf('  packages:') + 240)
    expect(pkgList).toContain("method: 'GET', path: '/v2.1/pcr/packages'")
    expect(pkgList).toContain('mutation: false')
  })

  it('activateESIM performs exactly ONE mutating POST /v2.1/pcr/packages (no retry/replay)', () => {
    const act = connector.slice(connector.indexOf('async activateESIM('), connector.indexOf('private async listEligibleIccids('))
    // The mutate call site is a single `this.createPackage(body)` inside the
    // claim loop — a claim only succeeds once, so at most one POST per dispatch.
    expect(act).toContain('const result = await this.createPackage(body)')
    expect(act).not.toMatch(/for\s*\(.*retry|while\s*\(/)
  })
})

describe('Telna deprecated admin mutation surface is isolated from runtime', () => {
  const connector = readConnector()
  const attempt = readAttemptService()
  const reconciliation = readReconciliation()
  const recovery = readRecovery()

  it('telna-connector.ts purchase path never calls updateSimPCRProfile / assignPackageToSim / refreshSimPCRProfile', () => {
    // The connector legitimately DECLARES updateSimPCRProfile (an unused provider
    // method on simPCRProfileUpdate), but the canonical purchase path
    // (activateESIM → createPackage) must never invoke it or the deprecated
    // admin assignment wrapper.
    const purchasePath = connector.slice(connector.indexOf('async activateESIM('), connector.indexOf('async getStatus('))
    expect(purchasePath).not.toMatch(/updateSimPCRProfile|assignPackageToSim|refreshSimPCRProfile/)
    const createPkg = connector.slice(connector.indexOf('async createPackage('), connector.indexOf('async topUpESIM('))
    expect(createPkg).not.toMatch(/updateSimPCRProfile|assignPackageToSim|refreshSimPCRProfile/)
  })

  it('shared provider-attempt / reconciliation / recovery never import the deprecated Telna assignment action', () => {
    for (const src of [attempt, reconciliation, recovery]) {
      expect(src).not.toMatch(/telna-package-assignment/)
      expect(src).not.toMatch(/assignPackageToSim|refreshSimPCRProfile|updateSimPCRProfile/)
    }
  })

  it('reconciliation only issues read-only status lookups (never a provider mutation)', () => {
    // The provider-neutral reconciliation path works through adapter.getActivationStatus
    // (→ connector.getStatus, read-only) — it must never reference a purchase mutation.
    expect(reconciliation).toContain('getActivationStatus')
    expect(reconciliation).not.toMatch(/PurhaseSim|pcr\/packages|createPackage/)
  })
})