import type { JobType } from '@prisma/client'
import { processDueJobs } from './queue'

/**
 * Low-latency in-process job worker.
 *
 * Continuously claims due jobs from the EXISTING BackgroundJob framework —
 * no second queue system. Purchase dispatch (PROVIDER_OPERATION) is claimed
 * first each tick so purchases never wait behind maintenance batches, while
 * reconciliation/status jobs still run every tick (no starvation).
 *
 * Safety: the atomic PENDING → PROCESSING claim and the stale-PROCESSING
 * sweep inside processDueJobs make this loop safe across multiple app
 * instances and across restarts (PM2 autorestart re-runs instrumentation,
 * which restarts this loop; crashed in-flight jobs are recovered by the sweep).
 */

const IDLE_POLL_MS = 1_000
const ERROR_BACKOFF_MS = 5_000

/** Job types that must start with minimal latency (customer-facing). */
const PRIORITY_JOB_TYPES: JobType[] = ['PROVIDER_OPERATION']

export interface WorkerLoopTickResult {
  priorityProcessed: number
  generalProcessed: number
}

/** One worker pass: priority jobs first, then everything else. */
export async function workerTick(): Promise<WorkerLoopTickResult> {
  const priority = await processDueJobs({ types: PRIORITY_JOB_TYPES, limit: 5 })
  const general = await processDueJobs({ limit: 10 })
  return { priorityProcessed: priority.length, generalProcessed: general.length }
}

const globalForWorker = globalThis as unknown as { __onesimJobWorkerStarted?: boolean }

/**
 * Start the continuous worker loop (idempotent per process). The timer is
 * unref'd so it never keeps the process alive on shutdown.
 */
export function startJobWorkerLoop(): void {
  if (globalForWorker.__onesimJobWorkerStarted) return
  globalForWorker.__onesimJobWorkerStarted = true

  console.log('[JOB_WORKER] started (priority types: PROVIDER_OPERATION)')

  const scheduleNext = (delayMs: number) => {
    const t = setTimeout(run, delayMs)
    t.unref?.()
  }

  async function run() {
    try {
      const { priorityProcessed } = await workerTick()
      // Fresh purchase work just ran — loop again immediately instead of idling.
      scheduleNext(priorityProcessed > 0 ? 0 : IDLE_POLL_MS)
    } catch (error: any) {
      console.error(`[JOB_WORKER] tick failed: ${error?.message || error}`)
      scheduleNext(ERROR_BACKOFF_MS)
    }
  }

  scheduleNext(0)
}
