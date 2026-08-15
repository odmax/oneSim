/**
 * Catalog readiness repair — pure CLI tooling helpers.
 *
 * SAFETY-ONLY TOOLING. No pricing arithmetic is duplicated here: readiness is
 * delegated to the canonical getPackagePurchaseReadiness, and repairs always
 * run through finalizeCatalogPackageConfiguration → recalculatePackagePrice →
 * computeEffectiveCost → canonical snapshot creation. No manual field
 * patching, no provider-name branches, no writes in dry-run.
 *
 * These pure functions are unit-tested; scripts/repair-configured-catalog-packages.ts
 * loads data with Prisma reads and feeds it here.
 */

import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export type RepairMode = 'dry-run' | 'apply'

export interface RepairFilters {
  provider?: string
  publishStatus?: string
  publishedOnly: boolean
  packageId?: string
  requireRetailLink: boolean
  all: boolean
  /** Explicit historical retail-cost recovery. Never part of normal runtime precedence. */
  recoverCostFromRetail: boolean
}

export interface ParsedRepairArgs {
  mode: RepairMode
  filters: RepairFilters
  hasTargetingFilter: boolean
  error?: string
}

export const VALID_PUBLISH_STATUSES = ['DRAFT', 'READY', 'PUBLISHED', 'HIDDEN', 'ARCHIVED']

function emptyFilters(): RepairFilters {
  return { provider: undefined, publishStatus: undefined, publishedOnly: false, packageId: undefined, requireRetailLink: false, all: false, recoverCostFromRetail: false }
}

function fail(error: string, mode: RepairMode = 'dry-run', filters: RepairFilters = emptyFilters()): ParsedRepairArgs {
  return { mode, filters, hasTargetingFilter: false, error }
}

/**
 * Parse CLI arguments for the catalog readiness repair tool.
 *
 * Safety contract:
 *   - default mode is DRY-RUN (no --apply) — zero writes.
 *   - --apply requires EITHER --all OR at least one targeting filter
 *     (--provider / --publish-status / --published-only / --package-id).
 *   - --published-only is an alias for --publish-status=PUBLISHED; supplying
 *     both inconsistently fails loudly.
 *   - invalid provider codes and publish-status values fail loudly (never
 *     silently ignored).
 */
export function parseRepairArgs(argv: string[]): ParsedRepairArgs {
  const flagNames = new Set(['--dry-run', '--apply', '--published-only', '--require-retail-link', '--all', '--recover-cost-from-retail'])
  const flags = new Set(argv.filter(a => flagNames.has(a)))
  const kv: Record<string, string> = {}
  for (const a of argv) {
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) kv[a.slice(0, eq)] = a.slice(eq + 1)
  }

  const apply = flags.has('--apply')
  const dryRun = flags.has('--dry-run')
  if (apply && dryRun) return fail('Cannot combine --dry-run and --apply')
  const mode: RepairMode = apply ? 'apply' : 'dry-run'

  // --provider=<code>
  const providerRaw = kv['--provider']
  let provider: string | undefined
  if (providerRaw !== undefined) {
    if (!providerRaw.trim()) return fail('--provider requires a non-empty value', mode)
    provider = providerRaw.trim().toUpperCase()
  }

  // --publish-status=<status>
  const publishRaw = kv['--publish-status']
  let publishStatus: string | undefined
  if (publishRaw !== undefined) {
    const up = publishRaw.trim().toUpperCase()
    if (!VALID_PUBLISH_STATUSES.includes(up)) {
      return fail(`Invalid --publish-status '${publishRaw}'. Valid values: ${VALID_PUBLISH_STATUSES.join(', ')}`, mode)
    }
    publishStatus = up
  }

  const publishedOnly = flags.has('--published-only')
  if (publishedOnly && publishStatus && publishStatus !== 'PUBLISHED') {
    return fail(`--published-only conflicts with --publish-status=${publishStatus}`, mode)
  }
  if (publishedOnly) publishStatus = 'PUBLISHED'

  // --package-id=<ProviderPackage.id>
  const packageIdRaw = kv['--package-id']
  let packageId: string | undefined
  if (packageIdRaw !== undefined) {
    if (!packageIdRaw.trim()) return fail('--package-id requires a non-empty value', mode)
    packageId = packageIdRaw.trim()
  }

  const requireRetailLink = flags.has('--require-retail-link')
  const all = flags.has('--all')
  const recoverCostFromRetail = flags.has('--recover-cost-from-retail')

  const filters: RepairFilters = { provider, publishStatus, publishedOnly, packageId, requireRetailLink, all, recoverCostFromRetail }
  const hasTargetingFilter = Boolean(provider || publishStatus || packageId)

  // Broad-apply protection: refuse unfiltered --apply unless --all.
  if (mode === 'apply' && !all && !hasTargetingFilter) {
    return fail('Refusing broad apply without --all or a targeting filter.', mode, filters)
  }

  return { mode, filters, hasTargetingFilter }
}

/**
 * Build the Prisma where clause from filters. Applied BEFORE classification.
 * Base scope remains configurationStatus CONFIGURED/AUTO_CONFIGURED (the
 * canonical population the tool is allowed to repair).
 */
export function buildRepairWhere(filters: RepairFilters): Record<string, unknown> {
  const where: any = {
    configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
  }
  if (filters.provider) where.provider = { code: { equals: filters.provider, mode: 'insensitive' } }
  if (filters.publishStatus) where.publishStatus = filters.publishStatus
  if (filters.packageId) where.id = filters.packageId
  return where
}

export type RepairCostSource = 'ADMIN' | 'PROVIDER' | 'RETAIL_RECOVERY' | 'MISSING'

export interface RepairClassifiedPackage {
  id: string
  name: string
  providerCode: string | null
  ready: boolean
  /** Normal repairable: provider/admin cost present (without relying on retail recovery). */
  repairable: boolean
  /** Explicit historical retail-cost recovery available (flag enabled). */
  recoverableRetailCost: boolean
  /** No recoverable cost anywhere (PP cost, admin cost, and retail cost all absent). */
  missingCostSource: boolean
  missingRetailLink: boolean
  costSource: RepairCostSource
  /** Historical retail cost (publishedAs.costPriceUSD) when present — the recovery input. */
  retailCost?: number | null
  reasons: string[]
}

/**
 * Provider-neutral recoverable-cost resolution for repair tooling.
 *
 * Normal runtime precedence (NEVER changed by this flag):
 *   adminCostPrice > 0  → ADMIN override wins
 *   else costPrice > 0  → provider cost
 *   else                → MISSING
 *
 * ONLY when `recoverCostFromRetail` is explicitly requested, a final fallback
 * is allowed: linked ESIMPackage.costPriceUSD > 0 → historical retail cost.
 * Cost is NEVER derived from sellingPrice/priceUSD/markupPercent/name/raw guesses.
 */
export function resolveRepairCostSource(pp: {
  adminCostPrice?: unknown
  costPrice?: unknown
  publishedAs?: { costPriceUSD?: unknown } | null
}, opts: { recoverCostFromRetail: boolean }): { costSource: RepairCostSource; retailCost: number | null } {
  const admin = pp.adminCostPrice ? Number(pp.adminCostPrice) : 0
  const provider = pp.costPrice ? Number(pp.costPrice) : 0
  if (admin > 0) return { costSource: 'ADMIN', retailCost: null }
  if (provider > 0) return { costSource: 'PROVIDER', retailCost: null }
  const retail = pp.publishedAs?.costPriceUSD ? Number(pp.publishedAs.costPriceUSD) : 0
  if (opts.recoverCostFromRetail && retail > 0) return { costSource: 'RETAIL_RECOVERY', retailCost: retail }
  return { costSource: 'MISSING', retailCost: null }
}

/**
 * Classify a single fetched ProviderPackage using the CANONICAL readiness
 * helper. Pure — never writes. `missingRetailLink` is set when
 * requireRetailLink is enabled and the package has no linked retail row
 * (publishedAs is null); such packages must be skipped, never repaired.
 */
export function classifyRepairPackage(
  pp: {
    id: string
    name: string
    costPrice?: unknown
    adminCostPrice?: unknown
    sellingPrice?: unknown
    publishedAs?: { id?: string; costPriceUSD?: unknown } | null
    provider?: { code?: string | null; status?: string | null; enabledCapabilities?: unknown } | null
  },
  opts: { requireRetailLink: boolean; recoverCostFromRetail: boolean },
): RepairClassifiedPackage {
  const readiness = getPackagePurchaseReadiness({
    providerPkg: pp as any,
    provider: pp.provider ? { status: pp.provider.status || '', enabledCapabilities: pp.provider.enabledCapabilities, code: pp.provider.code || null } : null,
  })
  const { costSource, retailCost } = resolveRepairCostSource(pp, { recoverCostFromRetail: opts.recoverCostFromRetail })
  const hasSellPrice = Number(pp.sellingPrice || 0) > 0
  const missingRetailLink = opts.requireRetailLink && !pp.publishedAs

  const base = !readiness.ready && hasSellPrice && !missingRetailLink
  const repairable = base && (costSource === 'ADMIN' || costSource === 'PROVIDER')
  const recoverableRetailCost = base && costSource === 'RETAIL_RECOVERY'
  const missingCostSource = base && costSource === 'MISSING'

  return {
    id: pp.id,
    name: pp.name,
    providerCode: pp.provider?.code || null,
    ready: readiness.ready,
    repairable,
    recoverableRetailCost,
    missingCostSource,
    missingRetailLink,
    costSource,
    retailCost: retailCost ?? null,
    reasons: readiness.ready ? [] : readiness.reasons,
  }
}

export function aggregateReasons(reasonsList: string[][]): { reason: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const reasons of reasonsList) {
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

export interface RepairReport {
  matched: number
  ready: number
  repairable: number
  notRepairable: number
  recoverableRetailCost: number
  missingCostSource: number
  skippedMissingRetailLink: number
  attempted: number
  repaired: number
  stillBlocked: number
  skipped: number
  failed: number
  beforeReasons: { reason: string; count: number }[]
  afterReasons: { reason: string; count: number }[]
}

export function emptyRepairReport(): RepairReport {
  return { matched: 0, ready: 0, repairable: 0, notRepairable: 0, recoverableRetailCost: 0, missingCostSource: 0, skippedMissingRetailLink: 0, attempted: 0, repaired: 0, stillBlocked: 0, skipped: 0, failed: 0, beforeReasons: [], afterReasons: [] }
}

/** Build the report header lines with the active filters (safe — no secrets). */
export function formatRepairHeader(mode: RepairMode, filters: RepairFilters): string[] {
  return [
    'CATALOG READINESS REPAIR',
    `MODE: ${mode.toUpperCase()}`,
    `PROVIDER_FILTER: ${filters.provider || '(none)'}`,
    `PUBLISH_STATUS_FILTER: ${filters.publishStatus || '(none)'}`,
    `PACKAGE_ID_FILTER: ${filters.packageId || '(none)'}`,
    `REQUIRE_RETAIL_LINK: ${filters.requireRetailLink ? 'true' : 'false'}`,
    `RECOVER_COST_FROM_RETAIL: ${filters.recoverCostFromRetail ? 'true' : 'false'}`,
    `ALL: ${filters.all ? 'true' : 'false'}`,
    '',
  ]
}

export function formatRepairReport(report: RepairReport): string[] {
  const lines: string[] = []
  lines.push(`Matched: ${report.matched}`)
  lines.push(`Already ready: ${report.ready}`)
  lines.push(`Repairable: ${report.repairable}`)
  lines.push(`Recoverable retail cost: ${report.recoverableRetailCost}`)
  lines.push(`Missing cost source: ${report.missingCostSource}`)
  lines.push(`Not repairable: ${report.notRepairable}`)
  lines.push(`Skipped missing retail link: ${report.skippedMissingRetailLink}`)
  lines.push('')
  lines.push('Before readiness reasons (aggregated):')
  if (report.beforeReasons.length === 0) lines.push('  (none)')
  for (const r of report.beforeReasons) lines.push(`  ${r.reason}: ${r.count}`)
  if (report.attempted > 0 || report.repaired > 0 || report.skipped > 0 || report.failed > 0) {
    lines.push('')
    lines.push(`Attempted: ${report.attempted}`)
    lines.push(`Repaired: ${report.repaired}`)
    lines.push(`Still blocked: ${report.stillBlocked}`)
    lines.push(`Skipped: ${report.skipped}`)
    lines.push(`Failed: ${report.failed}`)
  }
  if (report.afterReasons.length > 0) {
    lines.push('')
    lines.push('After readiness reasons (aggregated):')
    for (const r of report.afterReasons) lines.push(`  ${r.reason}: ${r.count}`)
  }
  return lines
}
