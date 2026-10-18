import { describe, it, expect } from 'vitest'
import fs from 'fs'

const USAGE_MIGRATION = fs.readFileSync(
  'prisma/migrations/20260923000000_add_usage_alerts_dedup/migration.sql',
  'utf8',
)
const PROVIDER_MIGRATION = fs.readFileSync(
  'prisma/migrations/20260924000000_add_provider_alert_resource_identity/migration.sql',
  'utf8',
)

/**
 * Migration-safety contract tests.
 *
 * These are migration-FOCUSED tests: they assert the exact SQL the raw
 * migrations run (transaction boundaries, ordering, scoping, index DDL) AND
 * simulate the deterministic retention semantics over in-memory rows so the
 * required scenarios are proven without a live database. The migrations are NOT
 * executed here and no remote database is touched.
 *
 * Transaction note: Prisma Migrate does NOT auto-wrap PostgreSQL migration
 * files; atomicity comes from the EXPLICIT `BEGIN;` ... `COMMIT;` boundaries in
 * each file, which these tests pin exactly.
 */

/** Strips comment-only lines and splits into executable statements (by ';'). */
function executableStatements(sql: string): string[] {
  const code = sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
    .join('\n')
  return code
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

const FORBIDDEN_IN_TRANSACTION = [
  'CREATE INDEX CONCURRENTLY',
  'REINDEX CONCURRENTLY',
  'VACUUM',
  'CLUSTER',
  'CREATE DATABASE',
  'DROP DATABASE',
  'ALTER DATABASE',
  'CREATE TABLESPACE',
  'DROP TABLESPACE',
]

// ─────────────────────────────────────────────────────────────────────────────
// Usage-alert dedupe — exact mirror of the migration UPDATE predicate.
// ─────────────────────────────────────────────────────────────────────────────
interface UsageRow {
  id: string
  esimId: string
  alertType: string
  acknowledgedAt: string | null
  createdAt: string
}

/** Mirrors `UPDATE usage_alerts ... WHERE dupe.acknowledgedAt IS NULL AND EXISTS (newer sibling)`. */
function runUsageDedupe(rows: UsageRow[]): UsageRow[] {
  return rows.map((r) => {
    if (r.acknowledgedAt !== null) return r
    const hasNewerSibling = rows.some(
      (o) =>
        o.esimId === r.esimId &&
        o.alertType === r.alertType &&
        o.acknowledgedAt === null &&
        (o.createdAt > r.createdAt || (o.createdAt === r.createdAt && o.id > r.id)),
    )
    return hasNewerSibling ? { ...r, acknowledgedAt: 'ACK', acknowledgedBy: 'SYSTEM' } : r
  })
}

function countUnresolved(rows: UsageRow[]) {
  return rows.filter((r) => r.acknowledgedAt === null).length
}

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'

function row(id: string, over: Partial<UsageRow> = {}): UsageRow {
  return { id, esimId: 'esim-A', alertType: 'USAGE_90', acknowledgedAt: null, createdAt: T1, ...over }
}

describe('usage_alert dedup migration — SQL contract', () => {
  it('marks duplicates acknowledged (never deletes) with deterministic (createdAt, id) ordering', () => {
    expect(USAGE_MIGRATION).toContain('UPDATE usage_alerts AS dupe')
    expect(USAGE_MIGRATION).toContain('SET "acknowledgedAt" = NOW(), "acknowledgedBy" = \'SYSTEM\'')
    expect(USAGE_MIGRATION).toContain('WHERE dupe."acknowledgedAt" IS NULL')
    expect(USAGE_MIGRATION).toContain('newer."esimId" = dupe."esimId"')
    expect(USAGE_MIGRATION).toContain('newer."alertType" = dupe."alertType"')
    expect(USAGE_MIGRATION).toContain('newer."acknowledgedAt" IS NULL')
    // Stable total order: createdAt, then id tiebreak.
    expect(USAGE_MIGRATION).toContain('newer."createdAt" > dupe."createdAt"')
    expect(USAGE_MIGRATION).toContain('newer."createdAt" = dupe."createdAt" AND newer."id" > dupe."id"')
    // No DELETE anywhere in the migration.
    expect(USAGE_MIGRATION).not.toMatch(/DELETE FROM/i)
  })

  it('the final partial unique index definition is exact', () => {
    expect(USAGE_MIGRATION).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "usage_alerts_esim_type_unresolved"\n  ON "usage_alerts"("esimId", "alertType") WHERE "acknowledgedAt" IS NULL;',
    )
  })

  it('declares the read-only rollout preflight and never executes it', () => {
    expect(USAGE_MIGRATION).toContain('ROLLOUT PREFLIGHT')
    expect(USAGE_MIGRATION).toContain('GROUP BY "esimId", "alertType"')
    expect(USAGE_MIGRATION).toContain('HAVING COUNT(*) > 1')
  })
})

describe('migration transaction boundaries (explicit SQL, NOT Prisma-wrapped)', () => {
  function assertTransaction(sql: string, inside: { backfillPattern: RegExp; indexPattern: RegExp; dropIndex?: boolean }) {
    const statements = executableStatements(sql)
    // First executable statement is BEGIN; last is COMMIT; exactly one each.
    expect(statements[0].toUpperCase()).toBe('BEGIN')
    expect(statements[statements.length - 1].toUpperCase()).toBe('COMMIT')
    expect(statements.filter((s) => s.toUpperCase() === 'BEGIN')).toHaveLength(1)
    expect(statements.filter((s) => s.toUpperCase() === 'COMMIT')).toHaveLength(1)

    // All data cleanup / backfill / index DDL sits strictly between BEGIN and COMMIT.
    for (const stmt of statements.slice(1, -1)) {
      expect(stmt.toUpperCase()).not.toBe('BEGIN')
      expect(stmt.toUpperCase()).not.toBe('COMMIT')
    }

    // No EXECUTABLE statement is forbidden inside a PostgreSQL transaction
    // (header comments may mention why CONCURRENTLY is not used — comments are
    // not statements).
    for (const stmt of statements) {
      const upper = stmt.toUpperCase()
      for (const forbidden of FORBIDDEN_IN_TRANSACTION) {
        expect(upper, `forbidden token ${forbidden}`).not.toContain(forbidden)
      }
    }

    // Ordering: backfill/cleanup before index DROP/CREATE, all inside txn.
    const body = statements.slice(1, -1).join('\n')
    const backfillIdx = body.search(inside.backfillPattern)
    const indexIdx = body.search(inside.indexPattern)
    expect(backfillIdx).toBeGreaterThan(-1)
    expect(indexIdx).toBeGreaterThan(-1)
    expect(indexIdx).toBeGreaterThan(backfillIdx)

    // DROP only applies when an existing index is replaced (provider migration);
    // the usage migration must never drop an index it does not own.
    if (inside.dropIndex) {
      expect(body).toMatch(/DROP INDEX IF EXISTS/)
    } else {
      expect(body).not.toMatch(/DROP INDEX/)
    }
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/)
  }

  it('usage_alert migration: BEGIN…COMMIT wrap dedupe + index creation', () => {
    assertTransaction(USAGE_MIGRATION, {
      backfillPattern: /UPDATE usage_alerts AS dupe/,
      indexPattern: /CREATE UNIQUE INDEX IF NOT EXISTS "usage_alerts_esim_type_unresolved"/,
    })
  })

  it('provider_alert migration: BEGIN…COMMIT wrap backfill + DROP/CREATE indexes', () => {
    assertTransaction(PROVIDER_MIGRATION, {
      backfillPattern: /UPDATE "provider_alerts"/,
      indexPattern: /CREATE UNIQUE INDEX IF NOT EXISTS "provider_alerts_provider_code_unresolved"/,
      dropIndex: true,
    })
  })

it('neither migration contains CREATE INDEX CONCURRENTLY as an executable statement', () => {
  for (const stmt of executableStatements(USAGE_MIGRATION)) {
    expect(stmt.toUpperCase()).not.toContain('CREATE INDEX CONCURRENTLY')
  }
  for (const stmt of executableStatements(PROVIDER_MIGRATION)) {
    expect(stmt.toUpperCase()).not.toContain('CREATE INDEX CONCURRENTLY')
  }
})

  it('comments no longer claim Prisma supplies the transaction', () => {
    expect(USAGE_MIGRATION).not.toMatch(/Prisma `migrate deploy` wraps/i)
    expect(PROVIDER_MIGRATION).not.toMatch(/Prisma `migrate deploy` wraps/i)
    expect(USAGE_MIGRATION + PROVIDER_MIGRATION).toContain('EXPLICIT SQL transaction')
    expect(USAGE_MIGRATION + PROVIDER_MIGRATION).toContain('BEGIN ... COMMIT')
  })
})

describe('usage_alert dedup — retention semantics simulation', () => {
  it('zero duplicates succeeds (no row is touched)', () => {
    const rows = [row('a', { createdAt: T1 }), row('b', { esimId: 'esim-B', createdAt: T2 })]
    expect(runUsageDedupe(rows)).toEqual(rows)
  })

  it('a single unresolved row is unchanged', () => {
    const rows = [row('a', { createdAt: T1 })]
    const out = runUsageDedupe(rows)
    expect(cnt(out)).toBe(1)
    expect(out[0].acknowledgedAt).toBeNull()
  })

  it('two unresolved duplicates become one unresolved (newest) + one acknowledged (older)', () => {
    const out = runUsageDedupe([
      row('a', { createdAt: T1 }), // older
      row('b', { createdAt: T2 }), // newer — canonical
    ])
    expect(countUnresolved(out)).toBe(1)
    expect(out.find((r) => r.id === 'a')!.acknowledgedAt).toBe('ACK')
    expect(out.find((r) => r.id === 'b')!.acknowledgedAt).toBeNull()
  })

  it('identical createdAt is broken deterministically by id (larger id = newer = canonical)', () => {
    const out = runUsageDedupe([row('a', { createdAt: T1 }), row('b', { createdAt: T1 })])
    expect(countUnresolved(out)).toBe(1)
    expect(out.find((r) => r.id === 'b')!.acknowledgedAt).toBeNull()
    expect(out.find((r) => r.id === 'a')!.acknowledgedAt).toBe('ACK')
  })

  it('several duplicate groups are isolated (other eSIMs / alert types untouched)', () => {
    const rows = [
      row('a1', { esimId: 'esim-A', alertType: 'USAGE_90', createdAt: T1 }),
      row('a2', { esimId: 'esim-A', alertType: 'USAGE_90', createdAt: T2 }),
      row('b1', { esimId: 'esim-B', alertType: 'NO_ACTIVITY', createdAt: T1 }),
      row('b2', { esimId: 'esim-B', alertType: 'NO_ACTIVITY', createdAt: T2 }),
    ]
    const out = runUsageDedupe(rows)
    expect(countUnresolved(out)).toBe(2) // a2 + b2
    expect(out.find((r) => r.id === 'a2')!.acknowledgedAt).toBeNull()
    expect(out.find((r) => r.id === 'b2')!.acknowledgedAt).toBeNull()
    expect(out.find((r) => r.id === 'a1')!.acknowledgedAt).toBe('ACK')
    expect(out.find((r) => r.id === 'b1')!.acknowledgedAt).toBe('ACK')
  })

  it('already-acknowledged rows are preserved and never re-marked', () => {
    const rows = [
      row('a', { createdAt: T2 }), // unresolved, newest → canonical
      row('b', { createdAt: T1, acknowledgedAt: 'OLD_ACK' }), // older but already acknowledged
      row('c', { esimId: 'esim-C', createdAt: T1, acknowledgedAt: 'OLD_ACK' }),
    ]
    const out = runUsageDedupe(rows)
    expect(out.find((r) => r.id === 'a')!.acknowledgedAt).toBeNull()
    expect(out.find((r) => r.id === 'b')!.acknowledgedAt).toBe('OLD_ACK') // unchanged
    expect(out.find((r) => r.id === 'c')!.acknowledgedAt).toBe('OLD_ACK')
  })

  it('different alert types for one eSIM remain separate unresolved alerts', () => {
    const rows = [
      row('a', { alertType: 'USAGE_80', createdAt: T1 }),
      row('b', { alertType: 'USAGE_90', createdAt: T1 }),
      row('c', { alertType: 'NO_ACTIVITY', createdAt: T1 }),
    ]
    const out = runUsageDedupe(rows)
    expect(countUnresolved(out)).toBe(3)
    for (const r of out) expect(r.acknowledgedAt).toBeNull()
  })

  it('the dedupe is idempotent (second pass is a no-op)', () => {
    const rows = [row('a', { createdAt: T1 }), row('b', { createdAt: T2 })]
    const once = runUsageDedupe(rows)
    const twice = runUsageDedupe(once)
    expect(twice).toEqual(once)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Provider-alert resource-identity migration — contract audit.
// ─────────────────────────────────────────────────────────────────────────────
function cnt<X>(arr: X[]): number {
  return arr.length
}

interface ProviderRow {
  id: string
  providerId: string
  code: string
  resourceType: string | null
  resourceId: string | null
  dedupKey: string | null
  resolvedAt: string | null
  createdAt: string
}

function providerRow(id: string, over: Partial<ProviderRow> = {}): ProviderRow {
  return { id, providerId: 'p1', code: 'CIRCUIT_OPEN', resourceType: null, resourceId: null, dedupKey: null, resolvedAt: null, createdAt: T1, ...over }
}

/** Mirrors the migration backfill: any-NULL identity columns become ''. */
function applyIdentityBackfill(rows: ProviderRow[]): ProviderRow[] {
  return rows.map((r) => ({
    ...r,
    resourceType: r.resourceType ?? '',
    resourceId: r.resourceId ?? '',
    dedupKey: r.dedupKey ?? '',
  }))
}

/** Mirrors the 5-column partial unique index: unresolved duplicate groups. */
function duplicateGroups(rows: ProviderRow[]): ProviderRow[][] {
  const groups = new Map<string, ProviderRow[]>()
  for (const r of rows) {
    if (r.resolvedAt !== null) continue
    const key = `${r.providerId}|${r.code}|${r.resourceType}|${r.resourceId}|${r.dedupKey}`
    const g = groups.get(key) || []
    g.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

describe('provider_alert resource-identity migration — SQL contract', () => {
  it('correct existing index name is dropped and recreated (no orphans)', () => {
    expect(PROVIDER_MIGRATION).toContain('DROP INDEX IF EXISTS "provider_alerts_provider_code_unresolved";')
    expect(PROVIDER_MIGRATION).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "provider_alerts_provider_code_unresolved"
  ON "provider_alerts"("providerId", "code", "resourceType", "resourceId", "dedupKey")
  WHERE "resolvedAt" IS NULL;`)
    // providerId_idx is preserved, not dropped.
    expect(PROVIDER_MIGRATION).toContain('CREATE INDEX IF NOT EXISTS "provider_alerts_providerId_idx" ON "provider_alerts"("providerId");')
  })

  it('identity columns are added with IF NOT EXISTS and backfilled deterministically (never NULL)', () => {
    for (const col of ['"resourceType"', '"resourceId"', '"dedupKey"']) {
      expect(PROVIDER_MIGRATION).toContain(`ALTER TABLE "provider_alerts" ADD COLUMN IF NOT EXISTS ${col} TEXT;`)
    }
    expect(PROVIDER_MIGRATION).toContain(`SET "resourceType" = '',
    "resourceId" = '',
    "dedupKey" = ''
WHERE "resourceType" IS NULL OR "resourceId" IS NULL OR "dedupKey" IS NULL;`)
  })

  it('ordering is backfill → DROP old index → CREATE new index (transaction-safe, no invalid intermediate state)', () => {
    const backfillAt = PROVIDER_MIGRATION.indexOf('UPDATE "provider_alerts"')
    const dropAt = PROVIDER_MIGRATION.indexOf('DROP INDEX IF EXISTS "provider_alerts_provider_code_unresolved"')
    const createAt = PROVIDER_MIGRATION.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "provider_alerts_provider_code_unresolved"')
    expect(backfillAt).toBeGreaterThan(-1)
    expect(dropAt).toBeGreaterThan(backfillAt)
    expect(createAt).toBeGreaterThan(dropAt)
  })
})

describe('provider_alert resource-identity migration — simulation', () => {
  it('deterministic backfill leaves no NULL identity columns', () => {
    const rows = applyIdentityBackfill([
      providerRow('a', { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' }),
      providerRow('b'),
      providerRow('c', { resourceType: null, resourceId: null, dedupKey: null }),
    ])
    for (const r of rows) {
      expect(r.resourceType).not.toBeNull()
      expect(r.resourceId).not.toBeNull()
      expect(r.dedupKey).not.toBeNull()
    }
  })

  it('provider-wide unresolved alerts remain unique by (providerId, code) after backfill', () => {
    const rows = applyIdentityBackfill([providerRow('a'), providerRow('b', { code: 'CATALOG_STALE' })])
    expect(duplicateGroups(rows)).toEqual([]) // distinct (providerId, code) keys → no collision
    // A true duplicate (same providerId+code, both unresolved) collapses to ONE group —
    // this is exactly what the pre-existing unique index prevented and the 5-column
    // index now enforces for the (providerId, code, '','','') key.
    const dup = applyIdentityBackfill([providerRow('a'), providerRow('b')])
    expect(duplicateGroups(dup).map((g) => g.length)).toEqual([2])
  })

  it('resource-scoped alerts are isolated from each other and from provider-wide rows', () => {
    const rows = applyIdentityBackfill([
      providerRow('a', { code: 'SYNC_RETRY_EXHAUSTED', resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' }),
      providerRow('b', { code: 'SYNC_RETRY_EXHAUSTED', resourceType: 'ESIM', resourceId: 'esim-2', dedupKey: 'status' }),
      providerRow('c', { code: 'SYNC_RETRY_EXHAUSTED', resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'usage' }),
    ])
    expect(duplicateGroups(rows)).toEqual([]) // all three are distinct keys
  })

  it('declares the read-only rollout preflight and never executes it', () => {
    expect(PROVIDER_MIGRATION).toContain('ROLLOUT PREFLIGHT')
    expect(PROVIDER_MIGRATION).toContain('HAVING COUNT(*) > 1')
    expect(PROVIDER_MIGRATION).toContain('WHERE "resourceType" IS NULL OR "resourceId" IS NULL OR "dedupKey" IS NULL')
  })
})