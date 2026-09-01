import fs from 'fs'
import type { Scenario, ProviderStrategy } from './scenarios'

/** Minimal .env loader (no dependency) — only fills keys not already set. */
function loadDotenv(): void {
  try {
    const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      const key = m[1]
      let value = m[2].replace(/^"|"$/g, '')
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch { /* no .env — rely on existing env */ }
}
loadDotenv()

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const eq = key.indexOf('=')
      if (eq >= 0) out[key.slice(0, eq)] = key.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[key] = argv[i + 1]; i++ }
      else out[key] = 'true'
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const scenario = (args.scenario || 'SUCCESS_SYNC') as Scenario
  const provider = (args.provider || 'AIRHUB') as ProviderStrategy
  const rps = parseInt(args.rps || '10', 10)
  const duration = parseInt(args.duration || '10', 10)
  const concurrency = parseInt(args.concurrency || '20', 10)
  const businesses = parseInt(args.businesses || '10', 10)
  const packagesPerProvider = parseInt(args['packages-per-provider'] || '25', 10)
  const quantity = parseInt(args.quantity || '1', 10)
  const workerCount = parseInt(args['worker-count'] || '2', 10)
  const seedSuffix = args.seed || `run-${Date.now().toString(36)}`
  const settle = parseInt(args.settle || '20', 10)
  const sameKey = args['same-idempotency-key'] === 'true'
  const ingressOnly = args['ingress-only'] === 'true'
  const maxInflight = args['max-inflight'] ? parseInt(args['max-inflight'], 10) : undefined

  const originalUrl = process.env.DATABASE_URL!
  const { classifyLoadDb } = await import('./load-db')
  if (!classifyLoadDb(originalUrl).ok) {
    // Provision the dedicated load DB from the maintenance URL.
    const { provisionLoadDatabase } = await import('./load-db')
    const { loadUrl, gate } = await provisionLoadDatabase(originalUrl, seedSuffix)
    console.log('LOAD_DB_GATE=' + (gate.ok ? 'PASS' : 'FAIL'))
    console.log('DATABASE_NAME=' + gate.databaseName)
    console.log('STAGING_DB_USED=' + (gate.stagingDbUsed ? 'YES' : 'NO'))
    console.log('PRODUCTION_DB_USED=' + (gate.productionDbUsed ? 'YES' : 'NO'))
    if (!gate.ok) process.exit(1)
    process.env.DATABASE_URL = loadUrl
  }
  // Enable the gated load-harness mode BEFORE any service module evaluates.
  process.env.LOAD_HARNESS = '1'
  const gate2 = classifyLoadDb(process.env.DATABASE_URL!)
  console.log('LOAD_DB_GATE=' + (gate2.ok ? 'PASS' : 'FAIL'))
  console.log('FAKE_PROVIDER_MODE=' + (gate2.ok ? 'YES' : 'NO'))
  process.env.PRISMA_QUERY_LOG_DISABLE = 'true'

  const { runLoad } = await import('./orchestrator-harness')
  const metrics = await runLoad({
    scenario, provider, rps, durationSec: duration, concurrency, businesses,
    packagesPerProvider, quantity, workerCount, seedSuffix, settleSec: settle, sameIdempotencyKey: sameKey,
    preProvisionedUrl: process.env.DATABASE_URL!,
    ingressOnly, maxInflight,
  })

  const { emitCapacityReport } = await import('./capacity-report')
  emitCapacityReport(metrics, { durationSec: duration, targetRps: rps })
  void classifyLoadDb
}

main().catch((e) => {
  console.error('RUN_LOAD_ERROR=' + String((e && (e.stack || e.message)) || e))
  process.exit(1)
})