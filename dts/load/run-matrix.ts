import fs from 'fs'
import type { Scenario, ProviderStrategy } from './scenarios'
import { PROVIDER_STRATEGIES, SCENARIOS } from './scenarios'
import { classifyLoadDb, provisionLoadDatabase } from './load-db'

function loadDotenv(): void {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
    }
  } catch { /* rely on env */ }
}
loadDotenv()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = process.argv.slice(2)
  const argsAny = (name: string): string | undefined => {
    const i = args.findIndex((a) => a.startsWith(`--${name}=`))
    return i >= 0 ? args[i].slice(name.length + 3) : undefined
  }
  const providers: ProviderStrategy[] = argsAny('providers')
    ? argsAny('providers')!.split(',').map((s) => s.trim() as ProviderStrategy)
    : ([] as ProviderStrategy[])
  const scenarios: Scenario[] = argsAny('scenarios')
    ? argsAny('scenarios')!.split(',').map((s) => s.trim() as Scenario)
    : ([] as Scenario[])
  const providersToRun = providers.length ? providers : ([...PROVIDER_STRATEGIES] as ProviderStrategy[])
  const scenariosToRun = scenarios.length ? scenarios : [...SCENARIOS]
  const rps = parseInt(argsAny('rps') || '10', 10)
  const duration = parseInt(argsAny('duration') || '10', 10)
  const settle = parseInt(argsAny('settle') || '6', 10)
  const businesses = parseInt(argsAny('businesses') || '10', 10)
  const workerCount = parseInt(argsAny('worker-count') || '2', 10)
  const concurrency = parseInt(argsAny('concurrency') || '16', 10)
  const batch = argsAny('batch') ? parseInt(argsAny('batch')!, 10) : 0

  // Shared dedicated load DB for the matrix.
  const { loadUrl, gate } = await provisionLoadDatabase(process.env.DATABASE_URL!, `matrix-${Date.now().toString(36)}`)
  if (!gate.ok) { console.log('MATRIX_DB_GATE=FAIL'); process.exit(1) }
  console.log('MATRIX_DB_GATE=PASS DATABASE_NAME=' + gate.databaseName)
  process.env.DATABASE_URL = loadUrl
  process.env.LOAD_HARNESS = '1'
  const { runLoad } = await import('./orchestrator-harness')

  let run = 0
  const rows: Array<Record<string, number | string>> = []
  for (const provider of providersToRun) {
    for (const scenario of scenariosToRun) {
      run += 1
      if (batch > 0 && (run - 1) >= batch) break
      console.log(`\n=== CELL ${provider}/${scenario} (${run}) ===`)
      const opts: import('./orchestrator-harness').RunOptions = {
        scenario, provider, rps, durationSec: duration, concurrency, businesses,
        packagesPerProvider: 40, quantity: 1, workerCount, seedSuffix: `m-${provider}-${scenario}`, settleSec: settle, sameIdempotencyKey: false,
        preProvisionedUrl: loadUrl, scope: `${provider}-${scenario}`.replace(/[^A-Z0-9_-]/gi, ''),
      }
      let metrics: Awaited<ReturnType<typeof runLoad>>
      try {
        metrics = await runLoad(opts)
      } catch (e) {
        console.error('CELL_ERROR=' + String(e))
        throw e
      }
      const { checkDbInvariants } = await import('./invariants')
      const invariant = await checkDbInvariants(metrics, metrics.orderIds)
      rows.push({
        provider, scenario,
        sent: metrics.requestsSent, accepted: metrics.requestsAccepted,
        fulfilled: metrics.ordersFulfilled, reconciliation: metrics.ordersReconciliation, failed: metrics.ordersFailed,
        duplicateDispatch: metrics.duplicateProviderDispatches, captureViolations: metrics.duplicateWalletCaptures,
        attemptNumDupes: invariant.attemptNumberDuplicates, result: invariant.runStatus,
      })
      if (invariant.runStatus === 'FAIL') {
        console.log('MATRIX_STOPPED=INVARIANT_FAILURE provider=' + provider + ' scenario=' + scenario)
        break
      }
      await sleep(500)
    }
  }
  console.log('\n=== MATRIX TABLE ===')
  for (const r of rows) console.log([r.provider, r.scenario, r.sent, r.accepted, r.fulfilled, r.reconciliation, r.failed, r.duplicateDispatch, r.captureViolations, r.attemptNumDupes, r.result].join('|'))
  console.log('MATRIX_ROWS_RUN=' + rows.length)
  try {
    fs.mkdirSync('dts/load/results', { recursive: true })
    const lines = ['provider|scenario|sent|accepted|fulfilled|reconciliation|failed|duplicateDispatch|captureViolations|attemptNumDupes|result',
      ...rows.map((r) => [r.provider, r.scenario, r.sent, r.accepted, r.fulfilled, r.reconciliation, r.failed, r.duplicateDispatch, r.captureViolations, r.attemptNumDupes, r.result].join('|'))]
    fs.writeFileSync('dts/load/results/matrix-latest.tsv', lines.join('\n'))
    console.log('MATRIX_WRITTEN=dts/load/results/matrix-latest.tsv')
  } catch (e) { console.log('MATRIX_WRITE_SKIP=' + String(e)) }
}

main().catch((e) => { console.error('MATRIX_MAIN_ERROR=' + String(e)); process.exit(1) })