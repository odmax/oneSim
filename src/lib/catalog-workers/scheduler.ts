import { processNextEvents } from './processor'
import { runHourlyReconciliation, runDailyReconciliation, runWeeklyReconciliation } from './reconciliation'
import { recoverStaleProcessingEvents } from './health'

const WORKER_ID = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let pollingInterval: ReturnType<typeof setInterval> | null = null
let hourlyInterval: ReturnType<typeof setInterval> | null = null
let dailyInterval: ReturnType<typeof setInterval> | null = null
let weeklyInterval: ReturnType<typeof setInterval> | null = null
let staleCheckInterval: ReturnType<typeof setInterval> | null = null
let isRunning = false

export function getWorkerId(): string {
  return WORKER_ID
}

export async function startWorker(pollIntervalMs = 2000): Promise<void> {
  if (isRunning) return
  isRunning = true

  console.log(`[WORKER] Starting worker ${WORKER_ID}, poll interval ${pollIntervalMs}ms`)

  pollingInterval = setInterval(async () => {
    try {
      const count = await processNextEvents(WORKER_ID)
      if (count > 0) {
        console.log(`[WORKER] Processed ${count} events`)
      }
    } catch (err) {
      console.error('[WORKER] Poll error:', err)
    }
  }, pollIntervalMs)

  // Recover stale PROCESSING events every 5 minutes
  staleCheckInterval = setInterval(async () => {
    try {
      const result = await recoverStaleProcessingEvents()
      if (result.recovered > 0) {
        console.log(`[WORKER] Recovered ${result.recovered} stale processing events`)
      }
    } catch (err) {
      console.error('[WORKER] Stale check error:', err)
    }
  }, 5 * 60 * 1000)

  hourlyInterval = setInterval(async () => {
    try {
      const result = await runHourlyReconciliation()
      if (result.errors.length > 0) {
        console.error('[WORKER] Hourly reconciliation errors:', result.errors)
      }
    } catch (err) {
      console.error('[WORKER] Hourly reconciliation error:', err)
    }
  }, 60 * 60 * 1000)

  dailyInterval = setInterval(async () => {
    try {
      const result = await runDailyReconciliation()
      if (result.errors.length > 0) {
        console.error('[WORKER] Daily reconciliation errors:', result.errors)
      }
    } catch (err) {
      console.error('[WORKER] Daily reconciliation error:', err)
    }
  }, 24 * 60 * 60 * 1000)

  weeklyInterval = setInterval(async () => {
    try {
      const result = await runWeeklyReconciliation()
      if (result.errors.length > 0) {
        console.error('[WORKER] Weekly reconciliation errors:', result.errors)
      }
    } catch (err) {
      console.error('[WORKER] Weekly reconciliation error:', err)
    }
  }, 7 * 24 * 60 * 60 * 1000)

  // Run initial cleanup and reconciliation after short delay
  setTimeout(async () => {
    try {
      await recoverStaleProcessingEvents()
    } catch (err) {
      console.error('[WORKER] Initial stale recovery error:', err)
    }
    try {
      await runHourlyReconciliation()
    } catch (err) {
      console.error('[WORKER] Initial reconciliation error:', err)
    }
  }, 10000)
}

export function stopWorker(): void {
  if (pollingInterval) clearInterval(pollingInterval)
  if (staleCheckInterval) clearInterval(staleCheckInterval)
  if (hourlyInterval) clearInterval(hourlyInterval)
  if (dailyInterval) clearInterval(dailyInterval)
  if (weeklyInterval) clearInterval(weeklyInterval)
  pollingInterval = null
  staleCheckInterval = null
  hourlyInterval = null
  dailyInterval = null
  weeklyInterval = null
  isRunning = false
  console.log('[WORKER] Stopped')
}

export function isWorkerRunning(): boolean {
  return isRunning
}
