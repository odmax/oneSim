import { prisma } from '@/lib/prisma'
import { computeProviderHealth } from '@/lib/services/operations/provider-health-score'

const SAFE_RECOVERY_ACTIONS = ['reAuth', 'retrySync', 'clearLocks'] as const

export async function executeProviderSelfHeal(): Promise<{ completed: boolean; result?: any; error?: string }> {
  const providers = await prisma.provider.findMany({ where: { status: { not: 'ARCHIVED' } } })

  let healthEvaluated = 0
  let recovered = 0
  const alerts: string[] = []

  for (const p of providers) {
    const health = await computeProviderHealth(p.id)
    healthEvaluated++

    // Store health snapshot in config
    const cfg = (p.config as any) || {}
    cfg.lastHealthScore = health.score
    cfg.lastHealthSeverity = health.health
    cfg.lastHealthEvaluatedAt = new Date().toISOString()
    await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})

    // Safe recovery actions based on health
    if (health.components.auth.score < 5) {
      // Re-auth: attempt token refresh for supported providers
      try {
        const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
        const connector = await buildConnectorFromProvider(p.id) as any
        if (connector?.refreshAuthentication) {
          await connector.refreshAuthentication()
          recovered++
          alerts.push(`${p.name}: re-authenticated`)
        }
      } catch {}
    }

    if (health.components.circuit.state === 'OPEN' && cfg.circuitBreaker?.openedAt) {
      const openedMs = Date.now() - new Date(cfg.circuitBreaker.openedAt).getTime()
      if (openedMs > 5 * 60_000) {
        cfg.circuitBreaker.state = 'HALF_OPEN'
        cfg.circuitBreaker.halfOpenedAt = new Date().toISOString()
        await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})
        recovered++
        alerts.push(`${p.name}: circuit → HALF_OPEN`)
      }
    }

    // Clear expired sync locks
    const expired = new Date(Date.now() - 5 * 60_000)
    await prisma.eSIM.updateMany({
      where: { purchase: { package: { providerId: p.id } }, statusNextSyncAt: { lte: expired }, lastStatusSyncAt: { lte: expired } },
      data: { statusNextSyncAt: new Date(Date.now() + 60_000) },
    }).catch(() => {})
  }

  console.log(`[PROVIDER_SELF_HEAL] evaluated=${healthEvaluated} recovered=${recovered}`)
  return { completed: true, result: { healthEvaluated, recovered, alerts } }
}
