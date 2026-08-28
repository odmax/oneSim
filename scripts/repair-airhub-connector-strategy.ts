/**
 * AIRHUB CONNECTOR-STRATEGY REPAIR — DRY-RUN BY DEFAULT.
 *
 * Canonical AirHub identity (post clean-rebuild, fd3c178):
 *   provider.code = 'AIRHUB'
 *   provider.adapterStrategy = 'AIRHUB'
 *
 * TEMPLATE (and CUSTOM / REST_CATALOG / STANDARD / empty) persisted on an exact
 * AIRHUB code is stale historical config from the pre-dedicated AirHub
 * integration. This script repairs ONLY the adapterStrategy and the two obsolete
 * template-driven config keys:
 *   config.providerMode
 *   config.templateDriven
 *
 * It NEVER touches:
 *   - endpointMappings / requestMappings / responseMappings
 *   - credentials / apiToken / auth accounts
 *   - base URLs / environment / authUrl
 *   - enabledCapabilities / capability exposure rows
 *   - any other config key
 *
 * DEFAULT: DRY RUN — prints SAFE fields only (no config values, no credentials).
 *
 * Usage:
 *   npx tsx scripts/repair-airhub-connector-strategy.ts              # dry-run
 *   npx tsx scripts/repair-airhub-connector-strategy.ts --apply      # gated apply
 *   npx tsx scripts/repair-airhub-connector-strategy.ts --apply --id <providerId>
 *
 * --apply requires:
 *   - exactly ONE exact-code AIRHUB provider, OR
 *   - an explicit --id <providerId> when multiple AIRHUB rows exist.
 *   - current strategy must be one of the expected historical values.
 *
 * This task does NOT run --apply against any environment.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface AirHubRepairRow {
  providerId: string
  code: string
  currentAdapterStrategy: string | null
  proposedAdapterStrategy: 'AIRHUB'
  hasProviderMode: boolean
  hasTemplateDriven: boolean
  obsoleteConfigKeysRemoved: string[]
  applyable: boolean
  skipReason?: string
}

const EXPECTED_HISTORICAL_STRATEGIES = ['TEMPLATE', 'CUSTOM', 'REST_CATALOG', 'STANDARD', '']

/** Strategies that can be safely auto-repaired to AIRHUB (or are already canonical). */
export function isCanonicalOrRepairable(strategy: string | null | undefined): boolean {
  return strategy === 'AIRHUB' || EXPECTED_HISTORICAL_STRATEGIES.includes(strategy ?? '')
}

export interface AirHubRepairPlan {
  rows: AirHubRepairRow[]
  providerIds: string[]
  requiresExplicitTarget: boolean
}

export function isAirHubCode(code: string | null | undefined): boolean {
  return code === 'AIRHUB'
}

/** Pure planning — no DB mutation. Builds the apply plan for the given providers. */
export function buildAirHubRepairPlan(
  providers: Array<{ id: string; code: string | null; adapterStrategy: string | null; config: unknown }>,
  targetId?: string,
): AirHubRepairPlan {
  const rows: AirHubRepairRow[] = []
  const selector = targetId
    ? providers.filter(p => p.id === targetId)
    : providers

  for (const p of selector) {
    const cfg = (p.config || {}) as Record<string, unknown>
    const hasProviderMode = 'providerMode' in cfg
    const hasTemplateDriven = 'templateDriven' in cfg
    const obsolete: string[] = []
    if (hasProviderMode) obsolete.push('providerMode')
    if (hasTemplateDriven) obsolete.push('templateDriven')

    const needsStrategyFix = p.adapterStrategy !== 'AIRHUB'
    const needsConfigFix = obsolete.length > 0
    const applyable = (needsStrategyFix || needsConfigFix)

    let skipReason: string | undefined
    if (p.code !== 'AIRHUB') {
      skipReason = 'Non-AIRHUB code — cannot be updated by this repair'
    } else if (!isCanonicalOrRepairable(p.adapterStrategy)) {
      skipReason = `Unexpected strategy "${p.adapterStrategy}" — manual review required`
    }

    rows.push({
      providerId: p.id,
      code: p.code || '?',
      currentAdapterStrategy: p.adapterStrategy,
      proposedAdapterStrategy: 'AIRHUB',
      hasProviderMode,
      hasTemplateDriven,
      obsoleteConfigKeysRemoved: obsolete,
      applyable: applyable && !skipReason,
      skipReason,
    })
  }

  // Fail-closed: multiple exact AIRHUB rows require an explicit --id target.
  const airhubCodes = rows.filter(r => r.code === 'AIRHUB')
  const requiresExplicitTarget = airhubCodes.length > 1 && !targetId

  return { rows, providerIds: rows.map(r => r.providerId), requiresExplicitTarget }
}

/** Remove ONLY the obsolete template-driven keys from a config clone; preserves everything else. */
export function cleanObsoleteAirHubConfig(currentConfig: unknown, keys: string[]): Record<string, unknown> {
  const cfg = (currentConfig || {}) as Record<string, unknown>
  const cleaned = { ...cfg }
  for (const key of keys) delete cleaned[key]
  return cleaned
}

/** Apply ONE already-planned row (strategy + obsolete config keys only). */
export async function applyAirHubRepair(
  row: AirHubRepairRow,
  currentConfig: unknown,
): Promise<{ applied: boolean; skipped: boolean; message: string }> {
  if (row.code !== 'AIRHUB') {
    return { applied: false, skipped: true, message: 'Non-AIRHUB provider cannot be repaired' }
  }
  if (!row.applyable || row.skipReason) {
    return { applied: false, skipped: true, message: row.skipReason || 'No change required' }
  }
  const cleaned = cleanObsoleteAirHubConfig(currentConfig, row.obsoleteConfigKeysRemoved)

  await prisma.provider.update({
    where: { id: row.providerId },
    data: {
      adapterStrategy: 'AIRHUB',
      ...(row.obsoleteConfigKeysRemoved.length > 0 ? { config: cleaned as any } : {}),
    },
  })
  return { applied: true, skipped: false, message: 'adapterStrategy → AIRHUB' + (row.obsoleteConfigKeysRemoved.length ? `; removed config keys ${row.obsoleteConfigKeysRemoved.join(', ')}` : '') }
}

async function main() {
  const APPLY = process.argv.includes('--apply')
  const idIndex = process.argv.indexOf('--id')
  const targetId = idIndex >= 0 ? process.argv[idIndex + 1] : undefined

  console.log(`\n=== AIRHUB CONNECTOR-STRATEGY REPAIR ${APPLY ? '(APPLY MODE)' : '(DRY-RUN)'} ===\n`)

  const providers = await prisma.provider.findMany({
    where: { code: 'AIRHUB' },
    select: { id: true, code: true, adapterStrategy: true, config: true },
  })

  if (providers.length === 0) {
    console.log('No exact-code AIRHUB provider found. Nothing to do.')
    console.log('Done.\n')
    await prisma.$disconnect()
    return
  }

  const plan = buildAirHubRepairPlan(providers, targetId)

  for (const row of plan.rows) {
    if (row.skipReason) {
      console.log(`  − ${row.code} (${row.providerId}) — SKIPPED: ${row.skipReason}`)
      continue
    }
    console.log(`  • ${row.code} (${row.providerId})`)
    console.log(`      providerId            ${row.providerId}`)
    console.log(`      code                  ${row.code}`)
    console.log(`      current strategy      ${row.currentAdapterStrategy ?? '(empty)'}`)
    console.log(`      proposed strategy     ${row.proposedAdapterStrategy}`)
    console.log(`      obsolete providerMode ${row.hasProviderMode}`)
    console.log(`      obsolete templateDriven ${row.hasTemplateDriven}`)
    console.log(`      config keys to remove [${row.obsoleteConfigKeysRemoved.join(', ') || 'none'}]`)
    console.log(`      action                ${row.applyable ? (APPLY ? 'APPLY' : 'WOULD APPLY (dry-run)') : 'no change'}`)
  }

  if (plan.requiresExplicitTarget) {
    console.log('\n  ⚠ Multiple exact-code AIRHUB records found. Re-run with --id <providerId> to target exactly one.')
  }

  console.log('\n=== SUMMARY ===')
  console.log(`AIRHUB_TARGETS=${plan.rows.length}`)
  console.log(`APPLYABLE=${plan.rows.filter(r => r.applyable && !r.skipReason).length}`)
  console.log(`REQUIRES_EXPLICIT_TARGET=${plan.requiresExplicitTarget}`)
  console.log('Same-row re-run is idempotent (strategy already AIRHUB → no change).')

  let writesPerformed = 0

  if (APPLY && !plan.requiresExplicitTarget) {
    const applyable = plan.rows.filter(r => r.applyable && !r.skipReason)
    for (const row of applyable) {
      const provider = await prisma.provider.findUnique({ where: { id: row.providerId } })
      if (!provider) continue
      const result = await applyAirHubRepair(row, provider.config)
      if (result.applied) writesPerformed++
      console.log(`APPLIED ${row.providerId}: ${result.message}`)
    }
    console.log('NOTE: verify with a subsequent dry-run (should show zero applyable rows).')
  }
  if (APPLY && plan.requiresExplicitTarget) {
    console.log('No writes performed — explicit target required.')
  }

  console.log(`MODE=${APPLY ? 'APPLY' : 'DRY-RUN'}  WRITES_PERFORMED=${writesPerformed}`)
  console.log('\nDone.\n')

  await prisma.$disconnect()
}

const entryArg = process.argv[1] || ''
const isDirectRun = entryArg.endsWith('repair-airhub-connector-strategy.ts') || entryArg.includes('repair-airhub-connector-strategy')
if (isDirectRun) main().catch(e => { console.error(e); process.exit(1) })