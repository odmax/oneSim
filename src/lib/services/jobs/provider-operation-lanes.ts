/**
 * PROVIDER-OPERATION LANE ADMISSION (distributed-safe, no schema change)
 *
 * Per-provider concurrency ceilings for PROVIDER_OPERATION execution. Provider A
 * saturating its lane must never consume the provider-operation capacity needed
 * by providers B/C, and the admission MUST be safe across multiple Node/PM2
 * worker processes.
 *
 * Mechanism:
 *  - Membership set of "laned" providers is hydrated from Provider.config
 *    (existing JSON) with a short TTL — the DEFAULT path (no lane configured)
 *    therefore adds ZERO queries per job and behaves exactly as before.
 *  - For a laned provider, admission runs in ONE transaction that:
 *      1. takes FOR UPDATE on the existing Provider row (Postgres row lock =
 *         the shared, cross-process serialization point),
 *      2. counts current PROCESSING background_jobs for that provider (derived
 *         in-flight = durable state, released automatically when a job reaches
 *         COMPLETED/FAILED/rescheduled),
 *      3. atomically claims the job PENDING→PROCESSING only if count < limit.
 *    If the lane is full the job is NOT claimed, stays PENDING with runAt<=now,
 *    and is re-selected on a later tick — no job loss, no stuck PROCESSING,
 *    no duplicate claims, no attempt inflation.
 */
import { prisma } from '@/lib/prisma'
import { claimJob, claimJobData } from './queue'
import { resolveProviderExecutionPolicy, laneLimitForOperation, type ProviderOperation } from '@/lib/providers/execution-policy'
import { providerOperationFromLabel } from '@/lib/providers/operation-capabilities'

const LANED_CACHE_TTL_MS = 60_000

let lanedProviders = new Set<string>()
let lanedCacheExpiry = 0

export interface LaneGateJob {
  id: string
  type: string
  payload: any
  providerId?: string | null
}

/** Refresh the process-local set of lane-configured providers (1 query, TTL-cached). */
export async function refreshLanedProviders(force = false): Promise<number> {
  if (!force && Date.now() < lanedCacheExpiry) return lanedProviders.size
  const rows = await prisma.provider.findMany({ select: { id: true, config: true } })
  const next = new Set<string>()
  for (const r of rows) {
    const exec = (r.config as any)?.execution
    if (exec !== undefined && exec !== null) next.add(r.id)
  }
  lanedProviders = next
  lanedCacheExpiry = Date.now() + LANED_CACHE_TTL_MS
  return next.size
}

/** Claim inside the admission transaction (identical data shape to claimJob). */
async function claimInTx(tx: any, jobId: string): Promise<boolean> {
  const res = await tx.backgroundJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: claimJobData(),
  })
  return res.count === 1
}

/**
 * Admit + atomically claim a PROVIDER_OPERATION job under its provider lane.
 * Returns true when claimed (PROCESSING) or false when the lane is full / the
 * job was already claimed by another worker (stays PENDING or stays another's).
 */
export async function admitProviderOperation(jobId: string, providerId: string, operation: ProviderOperation): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // 1. Serialize all admissions for this provider on the existing Provider row.
    const rows = await tx.$queryRaw<Array<{ config: any }>>`SELECT "config" FROM "providers" WHERE "id" = ${providerId} FOR UPDATE`
    const provider = rows?.[0]
    if (!provider) {
      // Provider vanished: never strand the order. Claim normally so the handler
      // observes the missing provider and routes to reconciliation.
      return claimInTx(tx, jobId)
    }
    const policy = resolveProviderExecutionPolicy({ id: providerId, config: provider.config })
    const limit = laneLimitForOperation(policy, operation)
    if (!limit) return claimInTx(tx, jobId)

    // 2. Derived in-flight count (durable, auto-released on completion).
    const inFlight = await tx.backgroundJob.count({
      where: { type: 'PROVIDER_OPERATION' as any, status: 'PROCESSING' as any, providerId },
    })
    if (inFlight >= limit) return false

    // 3. Atomic claim under the held provider lock.
    return claimInTx(tx, jobId)
  })
}

/**
 * Build a lane gate for processDueJobs. refreshLanedProviders() should be called
 * (cheap, TTL-cached) before creating a gate each worker tick.
 */
export function providerOperationLaneGate(): (job: LaneGateJob) => Promise<boolean> {
  return async (job: LaneGateJob): Promise<boolean> => {
    if (job.type !== 'PROVIDER_OPERATION') return claimJob(job.id)
    const providerId = typeof job.payload?.providerId === 'string' ? job.payload.providerId : (job.providerId || '')
    if (!providerId) return claimJob(job.id)
    // DEFAULT path: not lane-configured → plain claim (zero added queries).
    if (!lanedProviders.has(providerId)) return claimJob(job.id)
    const operation = providerOperationFromLabel(job.payload?.operation)
    return admitProviderOperation(job.id, providerId, operation)
  }
}