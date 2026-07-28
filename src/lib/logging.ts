/**
 * OneSIM Structured Logging — Production Hardening
 * ==================================================
 */

export function createLogger(context: string) {
  return {
    info(msg: string, data?: Record<string, unknown>) {
      console.log(JSON.stringify({ level: 'INFO', context, msg, ...(data || {}), ts: new Date().toISOString() }))
    },
    warn(msg: string, data?: Record<string, unknown>) {
      console.warn(JSON.stringify({ level: 'WARN', context, msg, ...(data || {}), ts: new Date().toISOString() }))
    },
    error(msg: string, error?: Error | string, data?: Record<string, unknown>) {
      const errStr = error instanceof Error ? error.message : error || undefined
      console.error(JSON.stringify({ level: 'ERROR', context, msg, error: errStr, ...(data || {}), ts: new Date().toISOString() }))
    },
    timing(label: string, durationMs: number, data?: Record<string, unknown>) {
      if (durationMs > 1000) {
        console.warn(JSON.stringify({ level: 'SLOW', context, label, durationMs, ...(data || {}), ts: new Date().toISOString() }))
      }
    },
  }
}

export type Logger = ReturnType<typeof createLogger>
