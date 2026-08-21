/**
 * Next.js instrumentation hook — runs once per server process on boot.
 * Starts the low-latency in-process job worker so purchase dispatch begins
 * within ~1s of enqueue instead of waiting for the external cron interval.
 *
 * The loop is safe across multiple instances (atomic job claims) and across
 * restarts (stale-PROCESSING sweep recovers crashed in-flight jobs).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.JOB_WORKER_ENABLED === 'false') return
    const { startJobWorkerLoop } = await import('./lib/services/jobs/worker-loop')
    startJobWorkerLoop()
  }
}
