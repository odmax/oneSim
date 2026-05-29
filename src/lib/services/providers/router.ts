import { prisma } from '@/lib/prisma'
import { getAdapterForType, isProviderOperational } from '@/lib/providers/adapter-manager'
import type { ProviderAdapter } from '@/lib/providers/adapter-types'

export interface OrderRequest {
  businessId: string
  customerId: string
  customerName: string
  customerEmail: string
  packageId: string
  quantity: number
}

export interface OrderResult {
  success: boolean
  orderId?: string
  esims?: Array<{
    id: string
    iccid: string
    imsi?: string | null
    activationCode?: string | null
    status: string
    qrCodeUrl?: string
  }>
  providerStatus?: string
  error?: string
  providerName?: string
}

interface RoutingContext {
  country?: string | null
  requiredCapabilities?: string[]
}

export async function resolveProviderTypeForPackage(pkg: {
  providerId?: string | null
  providerName?: string | null
  providerPlanId?: string | null
}, context?: RoutingContext): Promise<{ type: string; adapter?: ProviderAdapter | null; providerName?: string; providerId?: string }> {
  if (pkg.providerId) {
    const dbProvider = await prisma.provider.findUnique({ where: { id: pkg.providerId } })
    if (dbProvider && isProviderOperational(dbProvider.status)) {
      const adapter = await getAdapterForType(dbProvider.type, {
        apiBaseUrl: dbProvider.apiBaseUrl,
        apiToken: dbProvider.apiToken,
        providerId: dbProvider.id,
        environment: dbProvider.environment,
        authUrl: dbProvider.authUrl,
      })
      return { type: dbProvider.type, adapter, providerName: dbProvider.name, providerId: dbProvider.id }
    }
  }

  const operationalProviders = await prisma.provider.findMany({
    where: { status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] } },
    orderBy: { priority: 'asc' },
  })

  if (operationalProviders.length === 0) {
    return { type: 'CUSTOM', adapter: null, providerName: undefined }
  }

  if (context?.country) {
    for (const rp of operationalProviders) {
      const regions = rp.regions as any
      if (regions && Array.isArray(regions)) {
        const countryLower = context.country.toLowerCase()
        const countryMatch = regions.some((r: string) =>
          countryLower === r.toLowerCase() ||
          countryLower.includes(r.toLowerCase()) ||
          r.toLowerCase().includes(countryLower)
        )
        if (countryMatch) {
          const adapter = await getAdapterForType(rp.type, {
            apiBaseUrl: rp.apiBaseUrl, apiToken: rp.apiToken, providerId: rp.id, environment: rp.environment, authUrl: rp.authUrl,
          })
          return { type: rp.type, adapter, providerName: rp.name, providerId: rp.id }
        }
      }
    }
  }

  if (context?.requiredCapabilities?.length) {
    const required = context.requiredCapabilities
    for (const rp of operationalProviders) {
      const supportsAll = required.every(cap => {
        switch (cap) {
          case 'eSIM': return rp.supportsESIM
          case 'Usage': return rp.supportsUsage
          case 'SuspendResume': return rp.supportsSuspendResume
          case 'QR': return rp.supportsQRCode
          case 'TopUp': return rp.supportsTopUp
          case 'Pooling': return rp.supportsPools
          case 'Webhooks': return rp.supportsWebhookPush
          default: return true
        }
      })
      if (supportsAll) {
        const adapter = await getAdapterForType(rp.type, {
          apiBaseUrl: rp.apiBaseUrl, apiToken: rp.apiToken, providerId: rp.id, environment: rp.environment,
        })
        return { type: rp.type, adapter, providerName: rp.name, providerId: rp.id }
      }
    }
  }

  let bestProvider = operationalProviders[0]
  let bestScore = -Infinity

  for (const rp of operationalProviders) {
    const successRate = rp.activationSuccessRate ?? 50
    const errorCount = rp.errorCount ?? 0
    const avgTimeMs = rp.averageActivationTimeMs ?? 1000
    const priorityWeight = Math.max(0, 100 - rp.priority * 10)
    const healthScore = (successRate * 0.5) + (priorityWeight * 0.3) + (Math.max(0, 1000 - avgTimeMs) / 10 * 0.1) - (errorCount * 2 * 0.1)

    if (healthScore > bestScore) {
      bestScore = healthScore
      bestProvider = rp
    }
  }

  if (operationalProviders.length > 0) {
    const adapter = await getAdapterForType(bestProvider.type, {
      apiBaseUrl: bestProvider.apiBaseUrl, apiToken: bestProvider.apiToken, providerId: bestProvider.id, environment: bestProvider.environment, authUrl: bestProvider.authUrl,
    })
    return { type: bestProvider.type, adapter, providerName: bestProvider.name, providerId: bestProvider.id }
  }

  return { type: 'CUSTOM', adapter: null, providerName: undefined }
}

export async function routeOrder(request: OrderRequest): Promise<OrderResult> {
  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: request.packageId, isActive: true },
  })

  if (!pkg) {
    return { success: false, error: 'Package not found or inactive' }
  }

  const { adapter, providerName } = await resolveProviderTypeForPackage(pkg)

  if (!adapter) {
    return { success: false, error: 'No provider adapter available', providerName }
  }

  try {
    const planId = pkg.providerPlanId || pkg.id
    const nameParts = request.customerName.trim().split(/\s+/)
    const result = await adapter.activateESIM({
      planId,
      quantity: request.quantity,
      subscriber: {
        email: request.customerEmail,
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || undefined,
      },
      activationType: 'ACTIVATE_NOW',
      externalId: request.businessId,
    })

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error?.message || 'Provider activation failed',
        providerName,
      }
    }

    const data = result.data
    const iccids = data.iccids || []
    if (iccids.length < request.quantity) {
      return {
        success: false,
        error: `Provider returned fewer ICCIDs than requested (got ${iccids.length}, need ${request.quantity})`,
        providerName,
      }
    }

    return {
      success: true,
      orderId: data.activationId,
      esims: iccids.map((iccid: string, i: number) => ({
        id: `pending-${i}`,
        iccid,
        imsi: data.imsis?.[i] != null ? String(data.imsis[i]) : null,
        activationCode: data.activationCodes?.[i] != null ? String(data.activationCodes[i]) : null,
        status: 'PENDING_ACTIVATION',
        qrCodeUrl: data.qrCodeUrl || undefined,
      })),
      providerStatus: result.data.status || 'PENDING',
      providerName,
    }
  } catch (e: any) {
    return {
      success: false,
      error: `Provider error: ${e.message || 'Unknown error'}`,
      providerName,
    }
  }
}

export const providerRouter = { routeOrder }
