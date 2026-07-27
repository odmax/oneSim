import { prisma } from '@/lib/prisma'
import { isProviderOperational } from '@/lib/providers/adapter-manager'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'

export interface RoutingRequest {
  country?: string
  packageId?: string
  quantity?: number
  preferredProviderId?: string
  excludeProviderIds?: string[]
}

export interface ProviderScore {
  providerId: string
  providerName: string
  providerCode: string
  score: number
  breakdown: {
    health: number
    price: number
    latency: number
    balance: number
    successRate: number
    priority: number
  }
}

interface RoutingWeights {
  health: number
  price: number
  latency: number
  balance: number
  successRate: number
  priority: number
}

const DEFAULT_WEIGHTS: RoutingWeights = {
  health: 30,
  price: 25,
  latency: 15,
  balance: 10,
  successRate: 15,
  priority: 5,
}

export class ProviderRoutingEngine {
  private weights: RoutingWeights

  constructor(weights?: Partial<RoutingWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights }
  }

  async selectBestProvider(request: RoutingRequest): Promise<{ success: boolean; selected?: ProviderScore; candidates?: ProviderScore[]; error?: string }> {
    // If preferred provider is specified, return it immediately
    if (request.preferredProviderId) {
      const provider = await prisma.provider.findUnique({ where: { id: request.preferredProviderId } })
      if (provider && isProviderOperational(provider.status)) {
        return {
          success: true,
          selected: { providerId: provider.id, providerName: provider.name, providerCode: provider.code || '', score: 100, breakdown: { health: 100, price: 100, latency: 100, balance: 100, successRate: 100, priority: 100 } },
        }
      }
    }

    // Get eligible providers
    const excludeIds = request.excludeProviderIds || []
    const allProviders = await prisma.provider.findMany({
      where: {
        status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] },
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
    })

    const eligible = allProviders.filter(p => isProviderOperational(p.status))

    if (eligible.length === 0) return { success: false, error: 'No eligible providers found' }
    if (eligible.length === 1) {
      const p = eligible[0]
      return {
        success: true,
        selected: { providerId: p.id, providerName: p.name, providerCode: p.code || '', score: 100, breakdown: { health: 100, price: 100, latency: 100, balance: 100, successRate: 100, priority: 100 } },
        candidates: [{ providerId: p.id, providerName: p.name, providerCode: p.code || '', score: 100, breakdown: { health: 100, price: 100, latency: 100, balance: 100, successRate: 100, priority: 100 } }],
      }
    }

    // Get pricing info for the requested package
    let packagePrices: Record<string, number> = {}
    if (request.packageId) {
      const pkgs = await prisma.providerPackage.findMany({
        where: { id: request.packageId, providerId: { in: eligible.map(p => p.id) } },
        select: { providerId: true, costPrice: true },
      })
      for (const p of pkgs) {
        packagePrices[p.providerId] = Number(p.costPrice)
      }
    }

    // Score each provider
    const scored: ProviderScore[] = []
    for (const p of eligible) {
      const caps = (p.enabledCapabilities || DEFAULT_PROVIDER_CAPABILITIES[p.code || ''] || []) as string[]

      // Health score (errorCount, last connection)
      const healthScore = this.scoreHealth(p.errorCount || 0, p.lastSuccessfulConnection, p.lastFailedConnection)

      // Price score (lower is better)
      const priceRaw = packagePrices[p.id]
      const priceScore = priceRaw ? this.scorePrice(priceRaw, packagePrices) : 50

      // Latency score
      const latencyMs = (p.averageActivationTimeMs as number) || null
      const latencyScore = latencyMs ? this.scoreLatency(latencyMs) : 50

      // Balance score
      let balanceScore = 50
      if (caps.includes('BALANCE')) {
        try {
          const bal = await getProviderBalance(p.id)
          if (bal.success && bal.supported && bal.balance != null) {
            balanceScore = Math.min(100, Math.max(0, bal.balance > 0 ? 80 : 10))
          }
        } catch { }
      }

      // Success rate
      const successRate = (p.activationSuccessRate as number) || null
      const successRateScore = successRate != null ? Math.min(100, Math.max(0, successRate * 100)) : 50

      // Priority (lower is better, invert)
      const priorityRaw = p.priority || 0
      const priorityScore = Math.min(100, Math.max(0, 100 - priorityRaw * 2))

      const total = (
        healthScore * this.weights.health +
        priceScore * this.weights.price +
        latencyScore * this.weights.latency +
        balanceScore * this.weights.balance +
        successRateScore * this.weights.successRate +
        priorityScore * this.weights.priority
      ) / 100

      scored.push({
        providerId: p.id, providerName: p.name, providerCode: p.code || '',
        score: Math.round(total * 100) / 100,
        breakdown: { health: healthScore, price: priceScore, latency: latencyScore, balance: balanceScore, successRate: successRateScore, priority: priorityScore },
      })
    }

    scored.sort((a, b) => b.score - a.score)

    return {
      success: true,
      selected: scored[0],
      candidates: scored,
    }
  }

  private scoreHealth(errorCount: number, lastSuccess: Date | null, lastFailure: Date | null): number {
    if (errorCount === 0 && lastSuccess) return 100
    if (errorCount > 10) return 10
    if (errorCount > 5) return 30
    if (errorCount > 2) return 50
    if (lastFailure && !lastSuccess) return 20
    return 70
  }

  private scorePrice(price: number, allPrices: Record<string, number>): number {
    const prices = Object.values(allPrices).filter(v => v > 0)
    if (prices.length === 0) return 50
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    if (max === min) return 80
    return Math.round(100 - ((price - min) / (max - min)) * 100)
  }

  private scoreLatency(latencyMs: number): number {
    if (latencyMs < 1000) return 100
    if (latencyMs < 3000) return 80
    if (latencyMs < 5000) return 60
    if (latencyMs < 10000) return 40
    return 20
  }
}
