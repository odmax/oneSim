import fs from 'fs'
import { bootstrap, type BootstrapResult } from './bootstrap'

function loadDotenv(): void {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
    }
  } catch { /* rely on env */ }
}
loadDotenv()

function mainArg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const i = argv.findIndex((a) => a.startsWith(`--${name}=`))
  if (i >= 0) return argv[i].slice(name.length + 3)
  const j = argv.indexOf(`--${name}`)
  if (j >= 0 && j + 1 < argv.length && !argv[j + 1].startsWith('--')) return argv[j + 1]
  return undefined
}

interface Spec {
  name: string
  rps: number
  businesses: number
  packagesPerProvider: number
  inflight: number
  scope: string
  idemPrefix?: string
  seedSurface?: any
  note?: string
}

function summarize(kind: string, result: any, rps: number, duration: number): void {
  const m = result.metrics
  const target = Math.round(rps * duration)
  console.log(`${kind}_ACCEPTED_RPS=${(m.requestsAccepted / Math.max(1, m.generationDurationSec)).toFixed(2)}`)
  console.log(`${kind}_TARGET_ACHIEVEMENT_PERCENT=${(m.started > 0 ? Math.round((m.started / target) * 1000) / 10 : 0)}`)
  console.log(`${kind}_HTTP_P50_MS=${m.percentile(50) ?? 'null'}`)
  console.log(`${kind}_HTTP_P95_MS=${m.percentile(95) ?? 'null'}`)
  console.log(`${kind}_HTTP_P99_MS=${m.percentile(99) ?? 'null'}`)
  console.log(`${kind}_RUN_STATUS=${result.runStatus}`)
}

async function runSpec(bs: BootstrapResult, spec: Spec, duration: number): Promise<any> {
  const { runApiIngress } = await import('./api-harness')
  const result = await runApiIngress({
    name: spec.name,
    scenario: 'SUCCESS_SYNC',
    provider: 'AIRHUB',
    rps: spec.rps,
    durationSec: duration,
    maxInflight: spec.inflight,
    businesses: spec.businesses,
    packagesPerProvider: spec.packagesPerProvider,
    quantity: 1,
    settleSec: 6,
    scope: spec.scope,
    idemPrefix: spec.idemPrefix,
    uniqueIdempotencyKeys: true,
    preProvisionedUrl: bs.loadUrl,
    seedSurface: spec.seedSurface,
  })
  if (spec.note) console.log('API_NOTE=' + spec.note)
  return result
}

async function main(): Promise<void> {
  const bs: BootstrapResult = await bootstrap('apib')
  const series = mainArg('series')
  const duration = parseInt(mainArg('duration') || '20', 10)

  if (series === 'mt') {
    // Multi-tenant: fresh synthetic tenants per RPS step (100 businesses/step).
    // 100 businesses × 20 packages = 2000 (business,package) combos → the 30s
    // dedup window stays inert at every step (fastest repeat = 2000/100RPS = 20s
    // only at the very tail; 2000 requests in 20s hits each combo at most once).
    const step = mainArg('step')
    const rpsList = step === '250' ? [25, 50, 100, 250] : [25, 50, 100]
    for (const rps of rpsList) {
      const result = await runSpec(bs, { name: `API_MT_${rps}`, rps, businesses: 100, packagesPerProvider: 20, inflight: 50, scope: `mt${rps}` }, duration)
      summarize('API_MULTI_TENANT', result, rps, duration)
      if (result.runStatus === 'FAIL') { console.log('API_MULTI_TENANT_STOPPED=INVARIANT_FAILURE rps=' + rps); break }
    }
  } else if (series === 'sc') {
    // Single high-volume client: ONE business + ONE key, thousands of packages so
    // the real 30s dedup window never collapses distinct purchases.
    const { seedApiLoad } = await import('./api-seed')
    const surface = await seedApiLoad({ businesses: 1, packagesPerProvider: 3000, providers: ['AIRHUB'], quantity: 1, scope: 'sc' })
    const step = mainArg('step')
    const rpsList = step === '250' ? [25, 50, 100, 250] : [25, 50, 100]
    for (const rps of rpsList) {
      const result = await runSpec(bs, { name: `API_SC_${rps}`, rps, businesses: 1, packagesPerProvider: 3000, inflight: 50, scope: 'sc', idemPrefix: `sc${rps}`, seedSurface: surface }, duration)
      summarize('API_SINGLE_CLIENT', result, rps, duration)
      if (result.runStatus === 'FAIL') { console.log('API_SINGLE_CLIENT_STOPPED=INVARIANT_FAILURE rps=' + rps); break }
    }
    console.log('API_SINGLE_CLIENT_BUSINESS=' + surface.businessIds[0])
  } else {
    // Single spec.
    const name = mainArg('name') || 'API'
    const rps = parseInt(mainArg('rps') || '25', 10)
    const businesses = parseInt(mainArg('businesses') || '100', 10)
    const inflight = parseInt(mainArg('inflight') || '40', 10)
    const packagesPerProvider = parseInt(mainArg('packages') || '40', 10)
    const scope = mainArg('scope') || `api-${Date.now().toString(36)}`
    const result = await runSpec(bs, { name, rps, businesses, packagesPerProvider, inflight, scope }, duration)
    summarize('API', result, rps, duration)
    console.log('API_BENCH_DONE=' + name)
  }
}

main().catch((e) => { console.error('API_BENCH_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })