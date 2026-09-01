import fs from 'fs'

function loadDotenv(): void {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
    }
  } catch { /* rely on env */ }
}

export interface BootstrapResult { loadUrl: string; gate: { ok: boolean; databaseName: string; stagingDbUsed: boolean; productionDbUsed: boolean; reason?: string } }

/** Pure mis-bind check: the active Prisma connection MUST be the load DB. */
export function assertLoadDbBinding(actualDb: string, expectedDb: string): void {
  if (actualDb !== expectedDb) {
    throw new Error(`HARNESS_DB_MISBIND: singleton connected to '${actualDb}' but load DB is '${expectedDb}' — refusing to run`)
  }
}

/**
 * Provision a dedicated onesim_load_* DB and point DATABASE_URL at it BEFORE
 * any service module (and the Prisma singleton) is evaluated. This guarantees
 * the harness RUNS on the load DB — never the dev/staging/production DB.
 * Call in every entrypoint BEFORE dynamic-importing runLoad/services.
 */
export async function bootstrap(prefix: string): Promise<BootstrapResult> {
  loadDotenv()
  const { provisionLoadDatabase } = await import('./load-db')
  const originalUrl = process.env.DATABASE_URL!
  const { loadUrl, gate } = await provisionLoadDatabase(originalUrl, `${prefix}-${Date.now().toString(36)}`)
  console.log('LOAD_DB_GATE=' + (gate.ok ? 'PASS' : 'FAIL'))
  console.log('DATABASE_NAME=' + gate.databaseName)
  console.log('STAGING_DB_USED=' + (gate.stagingDbUsed ? 'YES' : 'NO'))
  console.log('PRODUCTION_DB_USED=' + (gate.productionDbUsed ? 'YES' : 'NO'))
  if (!gate.ok || gate.stagingDbUsed || gate.productionDbUsed) throw new Error('LOAD_DB_GATE FAILED')
  process.env.DATABASE_URL = loadUrl
  process.env.LOAD_HARNESS = '1'
  console.log('FAKE_PROVIDER_MODE=YES')
  return { loadUrl, gate }
}