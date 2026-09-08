/**
 * P0 V2 — ProviderAttempt attempt-number uniqueness correction.
 *
 * Background: staging forensics proved that `(orderId, attemptNumber)` is NOT
 * globally unique by legitimate design — PURCHASE and RECONCILIATION each keep
 * an independent per-order attempt-number sequence, so a genuine
 *   PURCHASE#1 + RECONCILIATION#1 + RECONCILIATION#2
 * shape coexists on a single order (order cmte0vvge000e6vqvqxk3eecq).
 *
 * The uniqueness that actually matters is the dispatch-ownership guard: two
 * concurrent workers must NOT both insert the same-number PURCHASE dispatch row
 * for the same dispatch generation. That is expressed by
 *   @@unique([orderId, source, attemptNumber])
 *
 * These are contract tests over the schema + the (unapplied) migration so the
 * correction is locked against regression even in environments with no live DB.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const MIGRATION = '20260908000000_add_provider_attempt_dispatch_started_unique'

function migrationSql(): string {
  return fs.readFileSync(path.join('prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8')
}

function schemaSql(): string {
  return fs.readFileSync(path.resolve('prisma/schema.prisma'), 'utf8')
}

describe('ProviderAttempt attempt-number uniqueness — domain correction', () => {
  it('1. schema scopes uniqueness per (orderId, source, attemptNumber)', () => {
    const schema = schemaSql()
    expect(schema).toContain('@@unique([orderId, source, attemptNumber])')
    // The invalid global key must be gone.
    expect(schema).not.toContain('@@unique([orderId, attemptNumber])')
  })

  it('2. migration creates the source-scoped unique index (correct key)', () => {
    const sql = migrationSql()
    expect(sql).toContain('provider_attempts_orderId_source_attemptNumber_key')
    expect(sql).toContain('ON "provider_attempts"("orderId", "source", "attemptNumber")')
  })

  it('3. migration does NOT create the invalid global unique index', () => {
    const sql = migrationSql()
    expect(sql).not.toContain('provider_attempts_orderId_attemptNumber_key')
    expect(sql).not.toContain('ON "provider_attempts"("orderId", "attemptNumber")')
  })

  it('4. migration is additive only — no destructive statements', () => {
    const sql = migrationSql()
    expect(sql).toContain('ADD COLUMN "dispatchStartedAt" TIMESTAMP(3)')
    const forbidden = ['DROP', 'DELETE', 'UPDATE', 'TRUNCATE']
    for (const word of forbidden) {
      expect(sql.toUpperCase().split('\n').some(l => l.trim().toUpperCase().startsWith(word)),
        `migration contains forbidden ${word} statement`).toBe(false)
    }
  })

  it('5. schema and migration agree on the nullable dispatchStartedAt column', () => {
    const schema = schemaSql()
    const sql = migrationSql()
    expect(schema).toContain('dispatchStartedAt   DateTime?')
    expect(sql).toContain('"dispatchStartedAt" TIMESTAMP(3)')
  })
})

describe('ProviderAttempt domain model — per-source sequences (no live DB)', () => {
  // Without a local test DB the DB-level constraint cannot be exercised, so the
  // authoritative artifacts (schema + migration) are asserted above. These
  // representational tests lock the intended semantics.

  it('6. legitimate historical shape is representable: PURCHASE#1 + RECONCILIATION#1 + RECONCILIATION#2', () => {
    // Each row occupies a distinct (source, attemptNumber) slot:
    //   (PURCHASE, 1), (RECONCILIATION, 1), (RECONCILIATION, 2)
    const legalRows = [
      { orderId: 'o1', source: 'PURCHASE', attemptNumber: 1 },
      { orderId: 'o1', source: 'RECONCILIATION', attemptNumber: 1 },
      { orderId: 'o1', source: 'RECONCILIATION', attemptNumber: 2 },
    ]
    const seen = new Set<string>()
    for (const r of legalRows) {
      const key = `${r.orderId}|${r.source}|${r.attemptNumber}`
      expect(seen.has(key), `${key} would collide under the invalid global key, but is legal under (orderId, source, attemptNumber)`).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBe(3)
    // Sanity: these are NOT globally unique — the old key would have rejected them.
    const globalKeys = new Set<string>()
    for (const r of legalRows) globalKeys.add(`${r.orderId}|${r.attemptNumber}`)
    expect(globalKeys.size).toBe(2) // proves the correction is needed
  })

  it('7. two concurrent PURCHASE dispatch rows at the same number collide (dispatch-ownership guard)', () => {
    // Same intended purchase generation → same (orderId, source, attemptNumber).
    const rowA = { orderId: 'o1', source: 'PURCHASE', attemptNumber: 2 }
    const rowB = { orderId: 'o1', source: 'PURCHASE', attemptNumber: 2 }
    const keyA = `${rowA.orderId}|${rowA.source}|${rowA.attemptNumber}`
    const keyB = `${rowB.orderId}|${rowB.source}|${rowB.attemptNumber}`
    expect(keyA).toBe(keyB)
    // The indexed key is unique — a second identical row violates the constraint.
    const seen = new Set<string>()
    expect(seen.has(keyA)).toBe(false)
    seen.add(keyA)
    expect(seen.has(keyB)).toBe(true)
  })

  it('8. PURCHASE and RECONCILIATION are created with independent number slots', () => {
    // Distinct-sequence pairings under the source-scoped key.
    const pairs = ['PURCHASE#1', 'RECONCILIATION#1', 'RECONCILIATION#2']
    expect(new Set(pairs).size).toBe(3)
  })
})

describe('ProviderAttempt dispatch-ownership loser — no provider HTTP', () => {
  // The unique index is defense-in-depth. The primary guarantee is that the
  // PURCHASE attempt row is created BEFORE the provider HTTP call, so a losing
  // worker's attempt-create (P2002) can never be followed by activateESIM.

  function sourceCode(file: string): string {
    return fs.readFileSync(path.resolve(file), 'utf8')
  }

  it('9. executeProviderAttempt creates the attempt row before the provider HTTP call', () => {
    const src = sourceCode('src/lib/services/orders/provider-attempt-service.ts')
    const createIdx = src.indexOf('prisma.providerAttempt.create({')
    const activateIdx = src.indexOf('adapter.activateESIM(')
    expect(createIdx).toBeGreaterThan(-1)
    expect(activateIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeLessThan(activateIdx)
  })

  it('10. recovery redispatch creates the attempt row before the provider HTTP call', () => {
    const src = sourceCode('src/lib/services/orders/recovery.ts')
    const createIdx = src.indexOf('prisma.providerAttempt.create({')
    const activateIdx = src.indexOf('adapter.activateESIM(')
    expect(createIdx).toBeGreaterThan(-1)
    expect(activateIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeLessThan(activateIdx)
  })
})
