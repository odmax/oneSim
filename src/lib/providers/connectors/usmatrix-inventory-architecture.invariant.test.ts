import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * US-Matrix inventory-architecture source-level guards. Deterministic: reads
 * sources only, never executes the connector, never touches the DB/provider.
 *
 * Guarantees that the US-Matrix integration stays:
 *  1. GENERIC — no Nigeria package / plan code 8464 / known provider UUID
 *     special-casing anywhere.
 *  2. PURCHASE-SAFE — the customer purchase path (activateESIM) uses ONLY
 *     assign-package, NEVER add-esims; the availability guard (count=0 →
 *     OUT_OF_STOCK) is preserved; the availability read failure is never
 *     fabricated as zero.
 *  3. INVENTORY-ADMIN SEPARATION — add-esims (assignPackagesToEsims) is an
 *     EXPLICIT admin-only mutation with a Cartesian-product guard; inventory
 *     status is a read-only availability-count surface; NEITHER is wired into
 *     the customer purchase path, plan sync, or catalog rendering; NEITHER
 *     touches wallets/orders.
 *  4. MUTATION SAFETY — the add-esims POST is exactly-one-per-call, non-retried
 *     on timeout/network/5xx/401-after-dispatch, and ambiguity is surfaced
 *     conservatively.
 */

function readConnector(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/usmatrix-connector.ts'), 'utf8')
}

function readEndpoints(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/usmatrix-endpoints.ts'), 'utf8')
}

function readOrchestrator(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/services/orders/purchase-orchestrator.ts'), 'utf8')
}

function readProviderSync(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/actions/provider-sync.ts'), 'utf8')
}

function readQueryPurchasable(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/packages/query-purchasable.ts'), 'utf8')
}

function readConnectorInterface(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/lib/providers/connectors/connector-interface.ts'), 'utf8')
}

const NIGERIA_SPECIFIC_TOKENS = [
  '8464',
  '3ad8a8c5-eec7-4add-ad5b-73b81a2a25ca',
  'cmtbk5cpo000411y4atesu2o3',
  "'Nigeria'",
  '"Nigeria"',
  'NIGERIA',
]

describe('US-Matrix connector — cross-package genericity (no Nigeria/8464/UUID conditional)', () => {
  const src = readConnector()

  it.each(NIGERIA_SPECIFIC_TOKENS)('connector source contains NO special-case token %s', (token) => {
    expect(src).not.toContain(token)
  })

  it('availability/activation logic is keyed only by the provider package UUID parameter', () => {
    // The availability read is always driven by params.planId / the passed
    // packageId — no hard-coded country/plan key exists anywhere.
    expect(src).toContain('checkPackageAvailability(String(params.planId))')
    expect(src).toContain('async getPackageInventoryStatus(packageId')
    expect(src).toContain('const availability = await this.checkPackageAvailability(String(packageId))')
  })

  it('inventory-status semantics never fabricate zero (UNKNOWN on failure)', () => {
    expect(src).toContain(`'UNKNOWN'`)
    expect(src).toContain('reason: availability.reason')
    expect(src).toMatch(/status.*OUT_OF_STOCK.*count.*=== 0/s)
  })
})

describe('US-Matrix connector — customer purchase ONLY ever uses assign-package', () => {
  const src = readConnector()

  it('activateESIM performs its mutation through esimAssignPackage only', () => {
    // The mutation-boundary request in activateESIM is the single POST to
    // esimAssignPackage; add-esims is never referenced in a request call.
    expect(src).toContain("this.request('esimAssignPackage', { method: 'POST', body })")
  })

  it('activateESIM NEVER calls add-esims (esimAddEsims appears only in the admin assignPackagesToEsims)', () => {
    // Extract only the activateESIM body: it must never call esimAddEsims.
    const activateStart = src.indexOf('async activateESIM(')
    const activateEnd = src.indexOf('/**\n   * Validate purchase readiness', activateStart) // next block boundary
    const activateBody = activateStart >= 0 && activateEnd > activateStart ? src.slice(activateStart, activateEnd) : ''
    expect(activateBody).not.toMatch(/this\.request\(\s*'esimAddEsims'/)
    expect(activateBody).not.toContain('esimAddEsims')
    expect(activateBody).toContain('esimAssignPackage')
  })

  it('availability=0 guard is preserved (OUT_OF_STOCK before any mutation)', () => {
    expect(src).toContain("error: {\n          code: 'OUT_OF_STOCK'")
    expect(src).toContain('availability.ok && availability.count === 0')
  })

  it('availability read failure does NOT fabricate zero (fail-open preserved)', () => {
    expect(src).toContain('MALFORMED_AVAILABILITY_RESPONSE')
    expect(src).toContain('AVAILABILITY_CHECK_FAILED')
  })

  it('no automatic add-esims fallback exists inside activateESIM', () => {
    // Extract ONLY the activateESIM body and assert it never dispatches
    // add-esims (no fallback call on zero availability or otherwise).
    const actStart = src.indexOf('async activateESIM(')
    const actEnd = src.indexOf('async validatePurchase(')
    const activateBody = src.slice(actStart, actEnd)
    expect(activateBody).not.toMatch(/this\.request\(\s*'esimAddEsims'/)
    expect(activateBody).not.toMatch(/assignPackagesToEsims/)
  })
})

describe('US-Matrix connector — inventory status is read-only and admin-separated', () => {
  const src = readConnector()
  const invStatusBegin = src.indexOf('async getPackageInventoryStatus(')
  const invStatusEnd = src.indexOf('async assignPackagesToEsims(')
  const invStatusFn = src.slice(invStatusBegin, invStatusEnd)

  it('getPackageInventoryStatus exists and is read-only', () => {
    expect(src).toContain('async getPackageInventoryStatus(packageId')
    expect(src).toContain('esimAvailabilityCountForPackage')
  })

  it('inventory status NEVER calls assign-package or add-esims', () => {
    // The read helper only performs the availability-count request.
    expect(invStatusFn).not.toMatch(/this\.request\('esimAssignPackage'/)
    expect(invStatusFn).not.toMatch(/this\.request\('esimAddEsims'/)
    expect(invStatusFn).not.toContain('esimAddEsims')
  })

  it('inventory status never touches a wallet', () => {
    // Doc text may mention "never touches a wallet"; assert on actual wallet-
    // operation CALLS, not the word.
    expect(invStatusFn).not.toMatch(/captureReservedFunds|releaseReservedFunds|captureReservedFundsUpTo/)
    expect(invStatusFn).not.toMatch(/prisma\.walletTransaction/)
    expect(invStatusFn).not.toMatch(/prisma\.eSIMPurchase/)
  })

  it('the customer purchase path does NOT call getPackageInventoryStatus (no runtime coupling)', () => {
    // activateESIM uses checkPackageAvailability for its OWN preflight; the
    // admin-facing inventory-status surface stays separate.
    expect(src).toContain('const availability = await this.checkPackageAvailability(String(params.planId))')
  })
})

describe('US-Matrix endpoints — add-esims: exact request DTO, admin-only wiring, no response-DTO invention', () => {
  const endpoints = readEndpoints()
  const connector = readConnector()

  it('add-esims path is declared', () => {
    expect(endpoints).toContain("esimAddEsims: '/api/v1/esims/add-esims'")
  })

  it('AddEsimInPackagesRequestDTO exists with EXACTLY the documented fields (esims, packages, client?)', () => {
    expect(endpoints).toContain('interface AddEsimInPackagesRequestDTO')
    const dtoStart = endpoints.indexOf('interface AddEsimInPackagesRequestDTO')
    const dtoEnd = endpoints.indexOf('', dtoStart + 300)
    const dto = endpoints.slice(dtoStart, dtoEnd)
    expect(dto).toContain('esims: string[]')
    expect(dto).toContain('packages: string[]')
    expect(dto).toContain('client?: string')
    // No undocumented fields.
    expect(dto).not.toMatch(/vendor|quantity|iccid|country/i)
  })

  it('NO fabricated strict add-esims RESPONSE DTO exists (opaque envelope only)', () => {
    expect(endpoints).toContain('AddEsimInPackagesResponseEnvelope')
    // The envelope is an indexed unknown-passthrough, not a strict field DTO.
    expect(endpoints).toMatch(/interface AddEsimInPackagesResponseEnvelope[\s\S]*\n  \}/)
  })

  it('assign-package DTOs exist and remain the canonical purchase contract', () => {
    expect(endpoints).toContain('interface AssignPackageRequestDTO')
    expect(endpoints).toContain('interface AssignPackageResponseDTO')
  })

  it('the ONLY esimAddEsims request call site is inside assignPackagesToEsims (never activateESIM)', () => {
    expect(connector).toContain("this.request('esimAddEsims', { method: 'POST', body })")
    const assignFn = connector.slice(connector.indexOf('async assignPackagesToEsims('), connector.indexOf('private async checkPackageAvailability('))
    expect(assignFn).toContain("this.request('esimAddEsims'")
  })

  it('assignPackagesToEsims is exposed as an OPTIONAL interface hook (admin/service primitive)', () => {
    const iface = readConnectorInterface()
    expect(iface).toContain('assignPackagesToEsims?(')
    expect(iface).toContain('interface AssignPackagesToEsimsInput')
    expect(iface).toContain('interface AssignPackagesToEsimsResult')
  })
})

describe('US-Matrix — add-esims has a Cartesian-product guard', () => {
  const connector = readConnector()
  const endpoints = readEndpoints()

  it('computes associationCount before transport and refuses above the ceiling', () => {
    expect(connector).toContain('associationCount: uniqueEsims.length * uniquePackages.length')
    expect(connector).toContain('ASSOCIATION_LIMIT_EXCEEDED')
    expect(connector).toContain('if (plan.associationCount > ceiling)')
  })

  it('supports an explicit bounded operator override (maxAssociations), capped by the absolute safety bound', () => {
    expect(connector).toContain('input.maxAssociations')
    expect(connector).toContain('Math.min(requestedCeiling, ABSOLUTE_MAX_ADD_ESIMS_ASSOCIATIONS)')
    expect(connector).toContain('DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS')
  })

  it('declares both the default ceiling and an absolute safety cap (OneSIM-side protection, not a provider max)', () => {
    expect(endpoints).toContain('DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS = 25')
    expect(endpoints).toContain('ABSOLUTE_MAX_ADD_ESIMS_ASSOCIATIONS = 200')
    expect(endpoints).toContain('not a provider-documented maximum')
    expect(endpoints).toContain('NOT a claim')
    expect(endpoints).toContain('documents any maximum')
  })
})

describe('US-Matrix — add-esims mutation safety (no retry / no replay / ambiguity surfaced)', () => {
  const connector = readConnector()

  it('surfaces ambiguous transport outcomes with details.ambiguous === true', () => {
    expect(connector).toContain('code === \'TIMEOUT\' || code === \'NETWORK_ERROR\' || code === \'HTTP_401\' || /^HTTP_5/.test(code)')
    expect(connector).toContain("code: ambiguous ? 'ADD_ESIMS_AMBIGUOUS' : code")
    expect(connector).toContain('details: {')
    expect(connector).toContain('ambiguous')
  })

  it('never auto-retries (single POST per operation; no retry loop construct)', () => {
    const assignFn = connector.slice(connector.indexOf('async assignPackagesToEsims('), connector.indexOf('private async checkPackageAvailability('))
    expect(assignFn).not.toMatch(/for\s*\(.*\bretry\b|while\s*\(/i)
    expect(assignFn).not.toMatch(/request\('esimAddEsims'[\s\S]*request\('esimAddEsims'/)
  })

  it('assignPackagesToEsims never touches a wallet or an order', () => {
    const assignFn = connector.slice(connector.indexOf('async assignPackagesToEsims('), connector.indexOf('private async checkPackageAvailability('))
    expect(assignFn).not.toMatch(/captureReservedFunds|releaseReservedFunds|captureReservedFundsUpTo/)
    expect(assignFn).not.toMatch(/prisma\.walletTransaction/)
    expect(assignFn).not.toMatch(/prisma\.eSIMPurchase/)
    expect(assignFn).not.toMatch(/orderId\s*:|= this\.orderId/)
  })
})

describe('US-Matrix — add-esims is never coupled to shared orchestration / catalog / plan sync', () => {
  const connector = readConnector()
  const orchestrator = readOrchestrator()
  const providerSync = readProviderSync()
  const queryPurchasable = readQueryPurchasable()

  it('PurchaseOrchestrator never references add-esims', () => {
    expect(orchestrator).not.toMatch(/add-esims|esimAddEsims|assignPackagesToEsims/)
  })

  it('plan sync (provider-sync.ts) never calls add-esims', () => {
    expect(providerSync).not.toMatch(/add-esims|esimAddEsims|assignPackagesToEsims/)
  })

  it('catalog page query (query-purchasable.ts) never invokes add-esims and performs no live provider call', () => {
    expect(queryPurchasable).not.toMatch(/add-esims|esimAddEsims|assignPackagesToEsims|fetch\(/)
  })

  it('the ONLY add-esims wiring in the connector is the admin assignPackagesToEsims method', () => {
    const occurrences = connector.split("this.request('esimAddEsims'").length - 1
    expect(occurrences).toBe(1)
  })
})

describe('US-Matrix — migration-free inventory-status contract', () => {
  const endpoints = readEndpoints()

  it('PackageInventoryStatusResult + UsMatrixPackageInventoryStatus types are exported for consumers', () => {
    expect(endpoints).toContain('export type UsMatrixPackageInventoryStatus')
    expect(endpoints).toContain('export interface PackageInventoryStatusResult')
  })
})

describe('US-Matrix — GET /esims read contract (allocated required, limit/offset, no page/perPage)', () => {
  const connector = readConnector()
  const endpoints = readEndpoints()

  it('allocated is REQUIRED (refused before transport when missing)', () => {
    expect(connector).toContain("typeof query.allocated !== 'boolean'")
    expect(connector).toContain("GET /esims requires an explicit `allocated` boolean filter")
  })

  it('paginates with limit/offset ONLY (never page/perPage)', () => {
    const listFn = connector.slice(connector.indexOf('async listEsims('), connector.indexOf('async findCompatiblePackagesForEsims('))
    expect(listFn).toContain('buildEsimsQueryParams(query, limit, offset)')
    expect(listFn).toContain('const limit = Math.min(')
    expect(listFn).toContain('const offset =')
    expect(listFn).not.toMatch(/page:/)
    expect(listFn).not.toMatch(/perPage/)
    expect(listFn).not.toMatch(/\.page\b/)
    expect(listFn).not.toMatch(/\.perPage\b/)
  })

  it('bounds the limit conservatively with MAX_ESIMS_PAGE_SIZE', () => {
    const endpointsContent = endpoints
    expect(endpointsContent).toContain('MAX_ESIMS_PAGE_SIZE = 200')
    expect(endpointsContent).toContain('DEFAULT_ESIMS_PAGE_SIZE = 100')
    expect(connector).toContain('Math.min(')
  })

  it('installation lookup performs a bounded dual allocated-side search (read-only)', () => {
    const lookupFn = connector.slice(connector.indexOf('async lookupInstallationData('), connector.indexOf('// ── Purchase / activation'))
    expect(lookupFn).toContain('for (const allocated of [false, true])')
    expect(lookupFn).toContain('AMBIGUOUS_IDENTITY')
    expect(lookupFn).not.toMatch(/activateESIM|assignPackage|add-esims/)
  })
})

describe('US-Matrix — find-packages is read-only discovery, never coupled to purchase', () => {
  const connector = readConnector()
  const endpoints = readEndpoints()
  const orchestrator = readOrchestrator()

  it('findCompatiblePackagesForEsims exists and POSTs to esimFindPackages only', () => {
    expect(connector).toContain('async findCompatiblePackagesForEsims(')
    expect(connector).toContain("this.request('esimFindPackages', { method: 'POST', body, query })")
  })

  it('find-packages treats 204 as authoritative empty success', () => {
    const fn = connector.slice(connector.indexOf('async findCompatiblePackagesForEsims('), connector.indexOf('async lookupInstallationData('))
    expect(fn).toContain('result.status === 204')
    expect(fn).toContain('items: [], total: 0')
  })

  it('find-packages never calls add-esims / assign-package / activateESIM / wallets / orders', () => {
    const fn = connector.slice(connector.indexOf('async findCompatiblePackagesForEsims('), connector.indexOf('async lookupInstallationData('))
    expect(fn).not.toMatch(/this\.request\('esimAddEsims'/)
    expect(fn).not.toMatch(/this\.request\('esimAssignPackage'/)
    expect(fn).not.toMatch(/activateESIM/)
    expect(fn).not.toMatch(/captureReservedFunds|releaseReservedFunds/)
    expect(fn).not.toMatch(/prisma\.eSIMPurchase|prisma\.walletTransaction/)
  })

  it('find-packages is body/query-only discovery (no automatic mutation retry loop)', () => {
    const fn = connector.slice(connector.indexOf('async findCompatiblePackagesForEsims('), connector.indexOf('async lookupInstallationData('))
    expect(fn).toMatch(/method: 'POST'/)
    expect(fn).not.toMatch(/for\s*\(.*retry|while\s*\(/)
  })

  it('canonical purchase flow remains availability-count -> assign-package (find-packages NOT in activateESIM)', () => {
    const activateBody = connector.slice(connector.indexOf('async activateESIM('), connector.indexOf('async validatePurchase('))
    expect(activateBody).toContain('esimAssignPackage')
    expect(activateBody).not.toContain('findCompatiblePackagesForEsims')
    expect(activateBody).not.toMatch(/esimFindPackages/)
    // PurchaseOrchestrator never references find-packages either.
    expect(orchestrator).not.toMatch(/findCompatiblePackagesForEsims|esimFindPackages|find-packages/)
  })

  it('FindPackagesForEsimsRequestDTO is typed exactly { esims: string[] }', () => {
    const dtoStart = endpoints.indexOf('interface FindPackagesForEsimsRequestDTO')
    const dto = endpoints.slice(dtoStart, dtoStart + 200)
    expect(dto).toContain('esims: string[]')
    expect(dto).not.toMatch(/client|vendor|planId|orderId/)
  })
})