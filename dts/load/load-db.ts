import { execFileSync } from 'child_process'
import path from 'path'

const LOAD_PREFIX = 'onesim_load_'

export function parseDatabaseUrl(url: string): { host: string; port: string; database: string } {
  const m = /^(?:postgres(?:ql)?:\/\/)?[^@/]+@([^:/?]+):?(\d+)?\/([^?]+)/.exec(url)
  if (!m) throw new Error('LOAD_DB_GATE_UNPARSEABLE_DATABASE_URL')
  return { host: m[1], port: m[2] || '5432', database: decodeURIComponent(m[3]) }
}

export interface LoadDbGate {
  ok: boolean
  databaseName: string
  stagingDbUsed: boolean
  productionDbUsed: boolean
  reason?: string
}

/** FAIL-CLOSED database gate: only databases named `onesim_load_*` may be used. */
export function classifyLoadDb(url: string): LoadDbGate {
  const parsed = parseDatabaseUrl(url)
  const db = parsed.database
  const host = parsed.host.toLowerCase()
  const stagingDb = host.includes('staging') || db.toLowerCase().includes('staging')
  const productionDb = (host.includes('prod') || host.includes('production')) && !host.includes('staging')
  if (!db.startsWith(LOAD_PREFIX)) {
    return { ok: false, databaseName: db, stagingDbUsed: stagingDb, productionDbUsed: productionDb, reason: `database name must start with ${LOAD_PREFIX}` }
  }
  if (stagingDb) return { ok: false, databaseName: db, stagingDbUsed: true, productionDbUsed: false, reason: 'staging-like host/db rejected' }
  if (productionDb) return { ok: false, databaseName: db, stagingDbUsed: false, productionDbUsed: true, reason: 'production-like host rejected' }
  return { ok: true, databaseName: db, stagingDbUsed: false, productionDbUsed: false }
}

async function createDatabaseIfMissing(maintenanceUrl: string, targetDb: string): Promise<void> {
  const { PrismaClient } = require('@prisma/client')
  const p = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } })
  try {
    const rows = await p.$queryRawUnsafe('SELECT 1 AS hit FROM pg_database WHERE datname = $1', targetDb)
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(`LOAD_DB_EXISTS=${targetDb}`)
    } else {
      await p.$executeRawUnsafe(`CREATE DATABASE "${targetDb}"`)
      console.log(`LOAD_DB_CREATED=${targetDb}`)
    }
  } finally {
    await p.$disconnect()
  }
}

function applySchema(loadUrl: string): void {
  const root = path.resolve(__dirname, '..', '..')
  const env = { ...process.env, DATABASE_URL: loadUrl }
  // Load DB only: sync schema directly against the dedicated onesim_load_* DB
  // (no migration-history dependency, no data to preserve).
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' })
  console.log('LOAD_DB_SCHEMA=SYNCED')
}

/**
 * Provision a dedicated load database.
 * - FAIL CLOSED if the source URL is staging/prod-like.
 * - If it already names a `onesim_load_*` DB: gate pass on it.
 * - Otherwise CREATE `onesim_load_<suffix>` (never the dev/maintenance DB) and
 *   apply the real schema. Only load-prefixed databases are ever created.
 */
export async function provisionLoadDatabase(originalUrl: string, suffix: string): Promise<{ loadUrl: string; gate: LoadDbGate }> {
  const gate = classifyLoadDb(originalUrl)
  if (gate.stagingDbUsed) throw new Error(`LOAD_DB_GATE FAIL: staging DB rejected (${gate.databaseName})`)
  if (gate.productionDbUsed) throw new Error(`LOAD_DB_GATE FAIL: production DB rejected (${gate.databaseName})`)
  if (gate.ok) {
    applySchema(originalUrl)
    return { loadUrl: originalUrl, gate }
  }

  const target = `${LOAD_PREFIX}${suffix}`
  const targetUrl = originalUrl.replace(/\/[^?/]+(\?.*)?$/, `/${target}$1`)
  console.log(`LOAD_DB_PROVISIONING_TARGET=${target}`)
  await createDatabaseIfMissing(originalUrl, target)
  applySchema(targetUrl)
  return { loadUrl: targetUrl, gate: classifyLoadDb(targetUrl) }
}