import { processDueJobs } from '../../src/lib/services/jobs/queue'
import { Metrics } from './metrics'

export interface WorkerOptions {
  workerCount: number
  pollMs: number
  batch: number
  shouldStop: () => boolean
  metrics: Metrics
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Harness worker executor: drives the REAL BackgroundJob claim/handler
 * architecture (processDueJobs → executeJob → provider-operation) in-process,
 * with harness-controlled worker count. No staging PM2.
 */
export async function runWorkers(opts: WorkerOptions): Promise<void> {
  const { workerCount, pollMs, batch, shouldStop, metrics } = opts
  await Promise.all(Array.from({ length: workerCount }, () => workerMain({ pollMs, batch, shouldStop, metrics })))
}

async function workerMain(opts: { pollMs: number; batch: number; shouldStop: () => boolean; metrics: Metrics }): Promise<void> {
  const { pollMs, batch, shouldStop, metrics } = opts
  while (!shouldStop()) {
    try {
      const res = await processDueJobs({ types: ['PROVIDER_OPERATION' as any], limit: batch })
      for (const r of res) {
        if (r.status === 'COMPLETED') metrics.jobsCompleted += 1
        else metrics.jobsFailed += 1
      }
      if (res.length === 0) await sleep(pollMs)
    } catch (e) {
      await sleep(100)
    }
  }
}