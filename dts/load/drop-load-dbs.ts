import fs from 'fs'

function loadDotenv(): void {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
    }
  } catch { /* rely on env */ }
}
loadDotenv()

/**
 * FAIL-CLOSED leftover load-DB cleanup. Only ever drops databases whose name
 * begins with `onesim_load_` and never on a staging/prod-like host. Serves the
 * "drop leftover onesim_load_* DBs safely before runs" requirement — normal
 * runs provision fresh load DBs each time, this reclaims the disk space they
 * leave behind.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL!
  const { parseDatabaseUrl, classifyLoadDb } = await import('./load-db')
  const gate = classifyLoadDb(url)
  if (gate.stagingDbUsed || gate.productionDbUsed) {
    console.log('DROP_LOAD_DBS=ABORT staging/prod-like host')
    process.exit(1)
  }
  const parsed = parseDatabaseUrl(url)
  const maintenanceUrl = url.replace(/\/[^?/]+(\?.*)?$/, `/${parsed.database}$1`)

  const { PrismaClient } = require('@prisma/client')
  const p = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } })
  try {
    const rows = await p.$queryRawUnsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'onesim\\_load\\_%'`)
    const dbs: string[] = (rows as Array<{ datname: string }>).map((r) => r.datname)
    console.log('DROP_LOAD_DBS_FOUND=' + dbs.length)
    let dropped = 0
    for (const db of dbs) {
      if (!db.startsWith('onesim_load_')) {
        console.log('DROP_LOAD_DBS_SKIP_NONLOAD=' + db)
        continue
      }
      try {
        await p.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, db)
      } catch { /* best effort */ }
      try {
        await p.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db.replace(/"/g, '""')}" WITH (FORCE)`)
        dropped += 1
        console.log('DROP_LOAD_DBS_DROPPED=' + db)
      } catch (e: any) {
        // Older PG: FORCE unsupported → terminate + plain drop fallback.
        if (/FORCE/.test(String(e?.message || ''))) {
          try {
            await p.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db.replace(/"/g, '""')}"`)
            dropped += 1
            console.log('DROP_LOAD_DBS_DROPPED=' + db)
          } catch (e2: any) {
            console.log('DROP_LOAD_DBS_FAILED=' + db + ' ' + String(e2?.message || e2))
          }
        } else {
          console.log('DROP_LOAD_DBS_FAILED=' + db + ' ' + String(e?.message || e))
        }
      }
    }
    console.log('DROP_LOAD_DBS_OK=' + dropped)
  } finally {
    await p.$disconnect()
  }
}

main().catch((e) => { console.error('DROP_LOAD_DBS_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })