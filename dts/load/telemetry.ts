import { monitorEventLoopDelay } from 'perf_hooks'

type Bucket = { count: number; totalMs: number; maxMs: number; log: number[] }
const buckets = new Map<string, Bucket>()
let attached = false

/** Probe-only raw queries (pg_stat_activity / current_database / SHOW) must not
 *  pollute the ingress order-path query buckets. */
function isProbeRawQuery(params: any): boolean {
  if (params && params.model) return false
  const sql = typeof params?.query === 'string' ? params.query : ''
  return /(pg_stat_activity|current_database\(|^\s*SHOW\b)/im.test(sql)
}

/** Harness-only Prisma query telemetry via $use middleware (no production change). */
export function attachQueryTelemetry(prisma: any): void {
  if (attached || typeof prisma?.$use !== 'function') return
  attached = true
  prisma.$use(async (params: any, next: any) => {
    if (isProbeRawQuery(params)) return next(params)
    const t0 = performance.now()
    const res = await next(params)
    const ms = performance.now() - t0
    const key = `${String(params.model ?? 'raw')}.${String(params.action)}`.toLowerCase()
    let b = buckets.get(key)
    if (!b) { b = { count: 0, totalMs: 0, maxMs: 0, log: [] }; buckets.set(key, b) }
    b.count += 1
    b.totalMs += ms
    if (ms > b.maxMs) b.maxMs = ms
    b.log.push(ms)
    return res
  })
}

/** Drop all accumulated buckets. Use to quarantine a measurement window
 *  (e.g. reset right after seeding so ingress-only query counts are clean). */
export function telemetryClear(): void {
  buckets.clear()
}

export function telemetryTotalCount(): number {
  let n = 0
  for (const b of buckets.values()) n += b.count
  return n
}

export function telemetrySummary(top = 15): Array<Record<string, number | string>> {
  const rows: Array<{ key: string; count: number; totalMs: number; p50: number; p95: number; p99: number; maxMs: number }> = []
  for (const [key, b] of buckets) {
    const s = [...b.log].sort((a, c) => a - c)
    const q = (p: number) => { if (s.length === 0) return 0; const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1)); return Math.round(s[i] * 10) / 10 }
    rows.push({ key, count: b.count, totalMs: Math.round(b.totalMs), p50: q(50), p95: q(95), p99: q(99), maxMs: Math.round(b.maxMs) })
  }
  rows.sort((a, b) => b.totalMs - a.totalMs)
  return rows.slice(0, top).map((r) => ({ ...r, key: r.key }))
}

export interface RunProbe {
  el: any
  genMs: number
  cpuStart: { user: number; system: number }
  pgActivePeak: number
  pgWaitingPeak: number
  pgMaxConnections: number
  pgSamplesActive: number[]
  pgSamplesWaiting: number[]
  startMs: number
}

export async function startProbe(prisma: any): Promise<RunProbe> {
  const el: any = (monitorEventLoopDelay as unknown as (opts?: { resolution?: number }) => any).call(null, { resolution: 10 })
  el.enable()
  return {
    el, genMs: 0, cpuStart: process.cpuUsage(), pgActivePeak: 0, pgWaitingPeak: 0, pgMaxConnections: 0,
    pgSamplesActive: [], pgSamplesWaiting: [], startMs: Date.now(),
  }
}

export async function sampleProbe(prisma: any, probe: RunProbe): Promise<void> {
  try {
    const r = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE datname = current_database()`)
    const active = Array.isArray(r) && r[0] ? Number(r[0].c) : 0
    probe.pgSamplesActive.push(active)
    if (active > probe.pgActivePeak) probe.pgActivePeak = active
  } catch { /* non-fatal */ }
  try {
    const g = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE state = 'active' AND wait_event_type IS NOT NULL`)
    const w = Array.isArray(g) && g[0] ? Number(g[0].c) : 0
    probe.pgSamplesWaiting.push(w)
    if (w > probe.pgWaitingPeak) probe.pgWaitingPeak = w
  } catch { /* non-fatal */ }
}

export async function finishProbe(prisma: any, probe: RunProbe): Promise<Record<string, number | string>> {
  probe.el.disable()
  // monitorEventLoopDelay reports NANOSECONDS — normalize to ms (÷1e6) so
  // EVENT_LOOP_* columns are real milliseconds, not ns integers.
  const elP50 = Math.round((probe.el.percentile(50) / 1e6) * 10) / 10
  const elP95 = Math.round((probe.el.percentile(95) / 1e6) * 10) / 10
  const elP99 = Math.round((probe.el.percentile(99) / 1e6) * 10) / 10
  const endCpu = process.cpuUsage(probe.cpuStart)
  const durUs = (Date.now() - probe.startMs) * 1000
  const cpuPct = durUs > 0 ? Math.round(((endCpu.user + endCpu.system) / durUs) * 100) : 0
  let maxConn = 0
  try {
    const r = await prisma.$queryRawUnsafe(`SHOW max_connections`)
    maxConn = Array.isArray(r) && r[0] ? Number(r[0].max_connections) : 0
  } catch { /* non-fatal */ }
  return { EVENT_LOOP_P50_MS: elP50, EVENT_LOOP_P95_MS: elP95, EVENT_LOOP_P99_MS: elP99, PROCESS_CPU_APPROX_PCT: cpuPct, PG_MAX_CONNECTIONS: maxConn, PG_ACTIVE_PEAK: probe.pgActivePeak, PG_WAITING_PEAK: probe.pgWaitingPeak }
}