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
 *  4. The Telna ICCID (A) can never masquerade as the provider package-instance
 *     reference (C): activationId is derived from pkg.id only, and a 2xx purchase
 *     response without a package instance id surfaces as an ambiguous,
 *     upstream-confirmed reconciliation outcome (claim HELD).
 *  5. Reconciliation correlation is read-only and EXACT: reconcileAmbiguousPurchase
 *     filters by exact claimed ICCIDs (+ exact package_template when known),
 *     resolves ONLY on a unique real package instance id (C), never by
 *     first/newest/time, and never repeats the activation POST.
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

describe('Telna package identity contract — ICCID (A) never masquerades as the activation reference (C)', () => {
  const connector = readConnector()

  it('activateESIM never falls back activationId to the ICCID and derives it from the package instance id only', () => {
    const act = connector.slice(connector.indexOf('async activateESIM('), connector.indexOf('async getStatus('))
    expect(act).not.toMatch(/\|\|\s*iccid/)
    expect(act).not.toMatch(/activationId\s*:\s*packageInstanceId\s*\|\|\s*iccid/)
    // The exact package instance id is the ONLY activationId source.
    expect(act).toContain('const packageInstanceId = String(pkg.id)')
    expect(act).toContain('activationId: packageInstanceId')
  })

  it('createPackage declares success ONLY with a returned package instance id; an id-less accepted 2xx is ambiguous & upstream-confirmed', () => {
    const fn = connector.slice(connector.indexOf('async createPackage('), connector.indexOf('async topUpESIM('))
    // A response without a package object (or an object without `id`) is never
    // a success — the ICCID (pkg.sim) alone is insufficient evidence.
    expect(fn).toMatch(/if\s*\(!pkg\s*\|\|\s*pkg\.id\s*==\s*null\s*\|\|/)
    expect(fn).toContain("String(pkg.id).trim() === ''")
    expect(fn).toMatch(/code\s*=\s*pkg\s*\?\s*'AMBIGUOUS_PACKAGE_ID_MISSING'\s*:\s*'INVALID_RESPONSE'/)
    // The failure is surfaced through the P0 ambiguous contract: claim HELD,
    // wallet reserved, reconciliation required — never a retryable/local code.
    expect(fn).toContain('ambiguous: true')
    expect(fn).toContain('upstreamConfirmed: true')
    expect(fn).toContain('reconciliationRequired: true')
    expect(fn).toContain('sim: req.sim')
    expect(fn).not.toMatch(/releaseProviderIccidClaim/)
  })
})

describe('Telna reconciliation correlation contract — read-only exact C recovery (TASK 3–8)', () => {
  const connector = readConnector()
  const reconciliation = readReconciliation()

  it('reconcileAmbiguousPurchase correlates ONLY via the read-only packages list, bounded by exact template id (B) + local exact ICCID (A)', () => {
    const fn = connector.slice(connector.indexOf('async reconcileAmbiguousPurchase('), connector.indexOf('async getV2Package('))
    expect(fn).toContain('async reconcileAmbiguousPurchase(input: AmbiguousPurchaseReconcileInput)')
    expect(fn).toContain('const correlated = await this.reconcileByTemplate(templateId, iccids)')
    expect(fn).toContain('providerPackageInstanceId')
    // FAIL CLOSED: no claimed ICCIDs or no valid numeric B -> inconclusive, zero provider scan.
    expect(fn).toContain("reason: 'inconclusive'")
    expect(fn).toContain('account-wide ICCID scan refused')
    expect(fn).toContain('no-match')
    expect(fn).toContain('RECONCILE_READ_FAILED')
    // READ-ONLY: never issues the creation mutation, never a POST.
    expect(fn).not.toMatch(/createPackage\(/)
    expect(fn).not.toMatch(/endpoint: 'packageCreate'/)
    expect(fn).not.toMatch(/method:\s*'POST'/)
    // Never a time/newest/first heuristic: no sort, no created_date correlation.
    expect(fn).not.toMatch(/\.sort\(|newest|created_date|startedAt|attemptedAt/)
    // The sole winner may be taken ONLY after the multiple-match guard.
    expect(fn).toContain('if (carriesRealId.length > 1)')
    expect(fn).toContain('const winner = carriesRealId[0]')
  })

  it('the packages list contract uses the documented V2.1 query names sim / package_template / inventory — never inventory_id / package_template_id', () => {
    // The documented GET /v2.1/pcr/packages filter surface is `inventory`,
    // `package_template`, `sim`, `status`, `count`, `offset`. The legacy
    // `inventory_id` / `package_template_id` names belong to OTHER endpoints
    // (path-param detail reads / sim-registry / template lists) and are NEVER
    // sent on the canonical package-list read. The `sim` filter is documented
    // and allowed; candidates are additionally verified locally so a provider
    // filter-lie can never certify the wrong ICCID.
    const fn = connector.slice(connector.indexOf('async listV2Packages('), connector.indexOf('private packageTemplateIdOf('))
    expect(fn).toContain('sim?: string')
    expect(fn).toContain('package_template?: number | string')
    expect(fn).toContain('inventory?: number | string')
    expect(fn).toContain("query: filters")
    expect(fn).not.toMatch(/package_template_id\?:|inventory_id\?:/)
    // The bounded correlation scan paginates with the documented names.
    const corr = connector.slice(connector.indexOf('private async reconcileByTemplate('), connector.indexOf('async reconcileAmbiguousPurchase('))
    expect(corr).toContain('sim: iccids.length === 1 ? iccids[0] : undefined')
    expect(corr).toContain('package_template: planId')
    expect(corr).not.toMatch(/package_template_id\b|inventory_id\b/)
    expect(corr).toContain('const iccidSet = new Set(iccids)')
  })

  it('resolution rules: unique real package instance id only; zero → no-match; several → multiple-matches', () => {
    const fn = connector.slice(connector.indexOf('async reconcileAmbiguousPurchase('), connector.indexOf('async getV2Package('))
    expect(fn).toContain("reason: 'unique-match'")
    expect(fn).toContain("reason: 'multiple-matches'")
    expect(fn).toContain("reason: 'no-match'")
    // A candidate without a package instance id must never resolve C.
    expect(fn).toContain('no provider reference to recover')
  })

  it('generic engine: Strategy 3 passes exact ICCIDs (+ planId) and promotes evidence.providerPackageInstanceId (C) as the durable provider reference', () => {
    expect(reconciliation).toContain('package: { select: { providerPlanId: true } }')
    expect(reconciliation).toContain('iccids: existingIccids')
    expect(reconciliation).toContain('providerPackageInstanceId')
    expect(reconciliation).toContain('const hasProvenRef = packageInstanceId != null && String(packageInstanceId).trim() !== \'\'')
  })

  it('generic engine: S1 non-terminal never prematurely prevents S3 (preserved pending verdict falls through)', () => {
    // A PENDING/PROCESSING S1 verdict is held in pendingResult instead of
    // returning immediately, so a connector creating C can recover it first.
    expect(reconciliation).toContain('let pendingResult: ReconciliationResult | null = null')
    expect(reconciliation).toContain('pendingResult = { outcome: \'STILL_PENDING\'')
    expect(reconciliation).toContain('if (pendingResult) return pendingResult')
    // Strategy 3 still runs before the generic ICCID-only search (Strategy 2).
    expect(reconciliation.indexOf('reconcileAmbiguousPurchase({')).toBeLessThan(reconciliation.indexOf('// Strategy 2:'))
  })
})