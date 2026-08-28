import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Canonical AirHub identity regression paths — source-level guards.
 *
 * AirHub is a DEDICATED provider integration (code=AIRHUB, strategy=AIRHUB).
 * Any historical writer that configured AIRHUB with adapterStrategy=TEMPLATE
 * (and providerMode/templateDriven config) must be fixed so it can never
 * re-introduce the stale template identity. These tests read the scripts'
 * sources (they are not executed) and assert the canonical fields.
 * ----------------------------------------------------------------------------
 * Deterministic: never executes the scripts, never touches the DB.
 */

function readScript(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

describe('seed-staging-providers.mjs — AirHub definition is canonical AIRHUB', () => {
  const src = readScript('scripts/seed-staging-providers.mjs')

  it('8. AirHub provider definition uses adapterStrategy: AIRHUB', () => {
    // Locate the AIRHUB provider block (code: 'AIRHUB', ... adapterStrategy: ...).
    const airhubCodeIndex = src.indexOf("code: 'AIRHUB'", src.indexOf("code: 'AIRHUB'"))
    expect(airhubCodeIndex).toBeGreaterThan(-1)
    // Between the AIRHUB provider object and the Rakuten block there must be an
    // AIRHUB adapterStrategy and NO TEMPLATE one.
    const raketenIndex = src.indexOf("code: 'RAKUTEN'")
    const airhubProviderSlice = src.slice(airhubCodeIndex, raketenIndex)
    expect(airhubProviderSlice).toContain("adapterStrategy: 'AIRHUB'")
    expect(airhubProviderSlice).not.toContain("adapterStrategy: 'TEMPLATE'")
  })

  it('AirHub provider config has no obsolete providerMode/templateDriven', () => {
    const airhubCodeIndex = src.indexOf("code: 'AIRHUB'")
    const raketenIndex = src.indexOf("code: 'RAKUTEN'")
    const airhubProviderSlice = src.slice(airhubCodeIndex, raketenIndex)
    expect(airhubProviderSlice).not.toContain("providerMode: 'TEMPLATE'")
    expect(airhubProviderSlice).not.toContain('templateDriven: true')
  })

  it('preserves AirHub credentials/auth/config fields (no removal of unrelated config)', () => {
    const airhubCodeIndex = src.indexOf("code: 'AIRHUB'")
    const raketenIndex = src.indexOf("code: 'RAKUTEN'")
    const airhubProviderSlice = src.slice(airhubCodeIndex, raketenIndex)
    expect(airhubProviderSlice).toContain('username')
    expect(airhubProviderSlice).toContain('password')
    expect(airhubProviderSlice).toContain('partnerCode')
    expect(airhubProviderSlice).toContain('configurationFields')
    expect(airhubProviderSlice).toContain('BEARER_HEADER')
  })

  it('Rakuten (generic template provider) is UNCHANGED — still TEMPLATE', () => {
    const raketenIndex = src.indexOf("code: 'RAKUTEN'")
    const choiceIndex = src.indexOf("code: 'CHOICE'")
    const raketenSlice = src.slice(raketenIndex, choiceIndex)
    expect(raketenSlice).toContain("adapterStrategy: 'TEMPLATE'")
  })
})

describe('repair-provider-configs.mjs — AirHub path is canonical AIRHUB', () => {
  const src = readScript('scripts/repair-provider-configs.mjs')

  it('9. AirHub CONFIGS entry uses adapterStrategy = AIRHUB and no template-drive keys', () => {
    const airhubIndex = src.indexOf('AIRHUB: {')
    const raketenIndex = src.indexOf('RAKUTEN: {')
    const airhubSlice = src.slice(airhubIndex, raketenIndex)
    expect(airhubSlice).toContain("adapterStrategy: 'AIRHUB'")
    expect(airhubSlice).not.toContain("adapterStrategy: 'TEMPLATE'")
    expect(airhubSlice).not.toContain("providerMode: 'TEMPLATE'")
    expect(airhubSlice).not.toContain('templateDriven: true')
  })

  it('generic RAKUTEN path remains TEMPLATE (only AirHub changed)', () => {
    const raketenIndex = src.indexOf('RAKUTEN: {')
    const choiceIndex = src.indexOf('CHOICE: {')
    const raketenSlice = src.slice(raketenIndex, choiceIndex)
    expect(raketenSlice).toContain("adapterStrategy: 'TEMPLATE'")
  })
})

describe('repair-airhub-auth.cjs — stays AIRHUB, idempotent, safe', () => {
  const src = readScript('scripts/repair-airhub-auth.cjs')

  it('10. enforces adapterStrategy → AIRHUB only for exact code AIRHUB', () => {
    expect(src).toContain("where: { code: 'AIRHUB' }")
    expect(src).toContain("adapterStrategy !== 'AIRHUB'")
    expect(src).toContain("update.adapterStrategy = 'AIRHUB'")
    expect(src).toContain("airhub.code !== 'AIRHUB'")
  })

  it('removes only obsolete template identity keys from config', () => {
    expect(src).toContain("delete cleaned.providerMode")
    expect(src).toContain("delete cleaned.templateDriven")
    // Never removes real credentials (username/password not deleted).
    expect(src).not.toContain("delete cleaned.username")
    expect(src).not.toContain("delete cleaned.password")
  })

  it('idempotent — only writes when a change is needed; dry-run by default', () => {
    expect(src).toContain('DRY_RUN')
    expect(src).toContain('changes.length > 0')
    // Applies via prisma.provider.update scoped to the AirHub id, never a
    // purchase/mutation endpoint.
    expect(src).toContain('p.provider.update')
    expect(src).not.toMatch(/activateESIM|topUp|Purchase|PurhaseSim|InsertRenew/)
  })

  it('never prints credentials/tokens', () => {
    expect(src).not.toMatch(/console\.log.*apiToken/)
    expect(src).not.toMatch(/console\.log.*token\b.*value/)
    // tokenStored is boolean-only.
    expect(src).toContain('tokenStored')
  })
})

describe('test-airhub-wallet.ts — canonical wallet action, no pre-abort on missing partnerCode', () => {
  const src = readScript('scripts/test-airhub-wallet.ts')

  it('I. does not pre-abort solely because config.partnerCode is absent', () => {
    // The script must call the canonical fetchAirhubWallet regardless of a
    // missing config partnerCode (auth derives/persists it first).
    expect(src).toContain('fetchAirhubWallet')
    expect(src).not.toContain("No partnerCode configured")
    expect(src).not.toContain("cfg.partnerCode")
  })

  it('never prints credentials or raw tokens', () => {
    expect(src).not.toMatch(/console\.log\([^)]*password/)
    expect(src).not.toMatch(/console\.log\([^)]*token/)
    expect(src).not.toMatch(/console\.log\([^)]*apiToken/)
  })
})

describe('diag-airhub-auth.ts — nested partnerCode support, safe output', () => {
  const src = readScript('scripts/diag-airhub-auth.ts')

  it('6. reads partnerCode from the nested data.data?.partnerCode response shape', () => {
    expect(src).toContain('data.data?.partnerCode')
  })

  it('does not expose credentials or raw token values', () => {
    // Password/username values are only ever printed through mask().
    expect(src).toContain('mask(cfg.password)')
    expect(src).toContain('mask(rawPassword)')
    // The raw login `data.token` / `sanitized.token` values are never echoed.
    expect(src).not.toMatch(/console\.log\([^)]*`\$\{data\.token\}/)
    expect(src).not.toMatch(/console\.log\([^)]*`\$\{sanitized\.token\}/)
    // Token is reported as a masked boolean-length indicator only.
    expect(src).toContain('Token present: YES (len=')
    // The sanitized full-response body masks the token before printing.
    expect(src).toContain(`sanitized.token = `)
  })
})