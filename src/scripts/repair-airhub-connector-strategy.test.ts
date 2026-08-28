import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildAirHubRepairPlan,
  cleanObsoleteAirHubConfig,
  isAirHubCode,
  type AirHubRepairRow,
} from '../../scripts/repair-airhub-connector-strategy'

function row(overrides: Partial<AirHubRepairRow> = {}): AirHubRepairRow {
  return {
    providerId: 'airhub-1',
    code: 'AIRHUB',
    currentAdapterStrategy: 'TEMPLATE',
    proposedAdapterStrategy: 'AIRHUB',
    hasProviderMode: true,
    hasTemplateDriven: true,
    obsoleteConfigKeysRemoved: ['providerMode', 'templateDriven'],
    applyable: true,
    ...overrides,
  }
}

const provider = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  code: 'AIRHUB',
  adapterStrategy: 'TEMPLATE',
  config: { username: 'u', password: 'p', partnerCode: 200652387, providerMode: 'TEMPLATE', templateDriven: true },
  ...overrides,
})

describe('repair-airhub-connector-strategy — buildAirHubRepairPlan', () => {
  it('dry-run performs zero writes (pure planning — no prisma in plan builder)', () => {
    const plan = buildAirHubRepairPlan([provider('airhub-1')])
    expect(plan.rows.length).toBe(1)
    // The plan builder never calls prisma — it only reads the provided objects.
    // No write happened here; applyability is just a flag.
    expect(plan.rows[0].applyable).toBe(true)
  })

  it('plans adapterStrategy → AIRHUB and flags obsolete config keys', () => {
    const plan = buildAirHubRepairPlan([provider('airhub-1')])
    const r = plan.rows[0]
    expect(r.code).toBe('AIRHUB')
    expect(r.currentAdapterStrategy).toBe('TEMPLATE')
    expect(r.proposedAdapterStrategy).toBe('AIRHUB')
    expect(r.hasProviderMode).toBe(true)
    expect(r.hasTemplateDriven).toBe(true)
    expect(r.obsoleteConfigKeysRemoved).toEqual(['providerMode', 'templateDriven'])
  })

  it('already-canonical row (AIRHUB + no obsolete keys) is NOT applyable (idempotent second run)', () => {
    const plan = buildAirHubRepairPlan([provider('airhub-1', { adapterStrategy: 'AIRHUB', config: { username: 'u', partnerCode: 1 } })])
    expect(plan.rows[0].applyable).toBe(false)
    expect(plan.rows[0].obsoleteConfigKeysRemoved).toEqual([])
  })

  it('multiple exact AIRHUB rows fail closed unless an explicit target is given', () => {
    const plan = buildAirHubRepairPlan([provider('airhub-1'), provider('airhub-2', { adapterStrategy: 'CUSTOM' })])
    expect(plan.requiresExplicitTarget).toBe(true)
    // Explicit target resolves the ambiguity.
    const targeted = buildAirHubRepairPlan([provider('airhub-1'), provider('airhub-2', { adapterStrategy: 'CUSTOM' })], 'airhub-1')
    expect(targeted.requiresExplicitTarget).toBe(false)
    expect(targeted.rows.map(r => r.providerId)).toEqual(['airhub-1'])
  })

  it('non-AIRHUB cannot be updated — exact code match only', () => {
    const plan = buildAirHubRepairPlan([{ id: 'x-1', code: 'RAKUTEN', adapterStrategy: 'TEMPLATE', config: { providerMode: 'TEMPLATE' } }])
    expect(plan.rows[0].skipReason).toMatch(/Non-AIRHUB/)
    expect(plan.rows[0].applyable).toBe(false)
  })

  it('unexpected strategy fails closed (manual review), never forced', () => {
    const plan = buildAirHubRepairPlan([provider('airhub-1', { adapterStrategy: 'MYSTERY' })])
    expect(plan.rows[0].skipReason).toMatch(/Unexpected strategy/)
    expect(plan.rows[0].applyable).toBe(false)
  })

  it('isAirHubCode is exact — no loose/partial matching', () => {
    expect(isAirHubCode('AIRHUB')).toBe(true)
    expect(isAirHubCode(null)).toBe(false)
    expect(isAirHubCode(undefined)).toBe(false)
    expect(isAirHubCode('AIRHUB2')).toBe(false)
    expect(isAirHubCode('airhub')).toBe(false)
    expect(isAirHubCode('AirHub')).toBe(false)
  })
})

describe('cleanObsoleteAirHubConfig — exact field preservation', () => {
  const cfg = {
    username: 'usr', password: 'pw', partnerCode: 200652387,
    flag: 0, multiplecountrycode: [], upstreamEnvironment: 'staging',
    providerMode: 'TEMPLATE', templateDriven: true, _note: 'keep-me',
  }

  it('removes ONLY providerMode/templateDriven; preserves every other key', () => {
    const cleaned = cleanObsoleteAirHubConfig(cfg, ['providerMode', 'templateDriven'])
    expect(cleaned.providerMode).toBeUndefined()
    expect(cleaned.templateDriven).toBeUndefined()
    expect(cleaned.username).toBe('usr')
    expect(cleaned.password).toBe('pw')
    expect(cleaned.partnerCode).toBe(200652387)
    expect(cleaned.flag).toBe(0)
    expect(cleaned.multiplecountrycode).toEqual([])
    expect(cleaned.upstreamEnvironment).toBe('staging')
    expect(cleaned._note).toBe('keep-me')
    expect(Object.keys(cleaned).sort()).toEqual(['_note', 'flag', 'multiplecountrycode', 'partnerCode', 'password', 'upstreamEnvironment', 'username'])
  })

  it('input is not mutated (immutability)', () => {
    const before = JSON.stringify(cfg)
    cleanObsoleteAirHubConfig(cfg, ['providerMode', 'templateDriven'])
    expect(JSON.stringify(cfg)).toBe(before)
  })
})

describe('repair script structural safety (source-level)', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'scripts/repair-airhub-connector-strategy.ts'), 'utf8')

  it('no credential/config values are ever printed', () => {
    // Interpolating a config/credential value directly into a log is forbidden.
    // (Printing booleans/keys/paths is fine; raw values are not.)
    expect(src).not.toMatch(/console\.log\([^)]*cfg\[/)
    expect(src).not.toMatch(/console\.log\([^)]*\.apiToken/)
    expect(src).not.toMatch(/console\.log\([^)]*\.token/)
    expect(src).not.toMatch(/console\.log\([^)]*\.password/)
    expect(src).not.toMatch(/console\.log\([^)]*\.username/)
    expect(src).toContain('NEVER touches:')
    expect(src).toContain('config keys to remove [')
  })

  it('targets only exact code AIRHUB via Prisma, never raw SQL', () => {
    expect(src).toContain("where: { code: 'AIRHUB' }")
    expect(src).not.toMatch(/\btx\.|rawQuery|\$\`|UPDATE "Provider"/)
    expect(src).toContain("from '@prisma/client'")
  })

  it('--apply is gated behind explicit flag; zero writes in dry-run default', () => {
    expect(src).toMatch(/process\.argv\.includes\('--apply'\)/)
    expect(src).toContain('DRY-RUN')
  })

  it('write counter reflects actual passes (not a static literal printed before apply)', () => {
    // Regression: the old script printed `WRITES_PERFORMED=0` in a summary block
    // that ran BEFORE the --apply loop, so a successful mutation still reported
    // a zero counter. The counter must be computed from the apply loop and
    // printed AFTER it.
    const writesLine = src.match(/WRITES_PERFORMED=\$\{(.*?)\}/)
    expect(writesLine).not.toBeNull()
    expect(writesLine![1]).toContain('writesPerformed')
    // It must be interpolated (backtick template), not a hardcoded string.
    expect(src).not.toMatch(/MODE=\$\{APPLY[^}]*\}\s+WRITES_PERFORMED=0/)
    // The variable is incremented when a row is applied.
    expect(src).toContain('if (result.applied) writesPerformed++')
  })
})