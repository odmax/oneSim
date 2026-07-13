import { encryptToken, decryptToken } from '@/lib/encryption'
import { prisma } from '@/lib/prisma'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'

interface AirHubCredentials {
  username: string
  password: string
}

interface AirHubAuthResult {
  success: boolean
  token?: string
  tokenExpiry?: string
  partnerCode?: number
  error?: string
}

interface AirHubPlan {
  planCode: string
  planName: string
  countryName?: string
  currency?: string
  price?: number
  capacity?: string
  capacityUnit?: string
  validity?: string
  validityType?: string
  connectivity?: string
  network_operator?: string
  countries_covered?: string
  phoneNumber?: boolean
  subscription?: boolean
  planType?: string
  additionalInfo?: string
  [key: string]: any
}

interface AirHubPlanResponse {
  isSuccess: boolean
  message?: string
  getInformation?: AirHubPlan[]
}

interface AirHubSyncResult {
  fetched: number
  created: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
}

export class AirHubConnector {
  private providerId: string
  private token: string | null = null

  constructor(providerId: string, token?: string | null) {
    this.providerId = providerId
    this.token = token || null
  }

  async authenticate(credentials: AirHubCredentials): Promise<AirHubAuthResult> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: 'Provider not found' }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authPath = provider.authUrl || '/api/Authentication/UserLogin'
    const url = `${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')}`

    console.log(`[AIRHUB_AUTH_START] providerId=${this.providerId} baseUrl=${baseUrl} resolvedUrl=${url}`)
    console.log(`[AIRHUB_AUTH_REQUEST] method=POST bodyFields=userName,password`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userName: credentials.username, password: credentials.password }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: 'AirHub returned non-JSON response' }
      }

      const respKeys = Object.keys(data)
      const dataKeys = data.data ? Object.keys(data.data) : []
      console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} isSuccess=${data.isSuccess} responseKeys=${respKeys.join(',')} dataKeys=${dataKeys.join(',')} tokenFound=${!!(data.token || data.data?.token)}`)

      if (!response.ok) {
        return { success: false, error: `AirHub auth failed: HTTP ${response.status}` }
      }

      if (data.isSuccess === false) {
        return { success: false, error: `AirHub rejected credentials: ${data.message || 'unknown'}` }
      }

      const token = data.token || data.accessToken || data.access_token || data.data?.token || ''
      if (!token || token.length < 8) {
        return { success: false, error: 'No valid token in AirHub auth response' }
      }

      // Normalize: strip Bearer prefix
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token.trim()
      const partnerCode = (data as any).partnerCode || (data as any).data?.partnerCode || (provider.config as any)?.partnerCode
      const tokenExpiry = data.token_expire || data.expiresAt || null

      // Persist encrypted token
      await prisma.provider.update({
        where: { id: this.providerId },
        data: {
          apiToken: encryptToken(cleanToken),
          tokenPlacement: 'BEARER_HEADER',
          lastSuccessfulConnection: new Date(),
          lastError: null,
          errorCount: 0,
          config: {
            ...((provider.config as any) || {}),
            lastAuthenticatedAt: new Date().toISOString(),
            authEnvironmentAtAuth: provider.environment || 'staging',
          },
        },
      })

      await recordHealthEvent(this.providerId, {
        eventType: 'CONNECTION_TEST',
        success: true,
        message: 'AirHub authenticated successfully',
      })

      console.log(`[AIRHUB_AUTH_RESULT] success=true tokenPersisted=true tokenExpiryPresent=${!!tokenExpiry} partnerCode=${partnerCode}`)

      this.token = cleanToken
      return { success: true, token: cleanToken, tokenExpiry: tokenExpiry || undefined, partnerCode }
    } catch (e: any) {
      const msg = e.name === 'AbortError' ? 'Auth timed out after 25s' : e.message
      console.log(`[AIRHUB_AUTH_ERROR] ${msg}`)
      await prisma.provider.update({
        where: { id: this.providerId },
        data: {
          lastFailedConnection: new Date(),
          lastError: msg.substring(0, 500),
          errorCount: { increment: 1 },
        },
      }).catch(() => {})
      return { success: false, error: msg }
    }
  }

  private ensureToken(): string {
    if (this.token) return this.token
    throw new Error('AirHub token not available. Authenticate first.')
  }

  async syncCatalog(): Promise<AirHubSyncResult> {
    const provider = await prisma.provider.findUnique({
      where: { id: this.providerId },
      select: { id: true, apiBaseUrl: true, apiToken: true, config: true, tokenPlacement: true },
    })
    if (!provider) return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: ['Provider not found'] }

    // Load token from DB if not in memory
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch { /* empty */ }
    }
    if (!this.token) return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: ['No token available. Authenticate first.'] }

    const config = (provider.config as any) || {}
    const partnerCode = config.partnerCode || 200652387
    const flag = config.flag || 6
    const countryCode = config.countryCode ?? ''
    const multiplecountrycode = config.multiplecountrycode || ['UK']
    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetPlanInformation`

    // Pre-send validation
    if (!partnerCode) return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: ['partnerCode missing'] }
    if (!multiplecountrycode || !Array.isArray(multiplecountrycode) || multiplecountrycode.length === 0) {
      return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: ['multiplecountrycode missing or empty'] }
    }

    const body = { partnerCode, flag, countryCode, multiplecountrycode }
    console.log(`[AIRHUB_GET_PLANS_REQUEST] url=${url} method=POST headerNames=Authorization,Content-Type,Accept hasAuthorization=true bodyFields=partnerCode,flag,countryCode,multiplecountrycode partnerCode=${partnerCode} flag=${flag} countryCode=${countryCode} multiplecountrycodeCount=${multiplecountrycode.length}`)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const text = await response.text()
    let data: AirHubPlanResponse
    try { data = JSON.parse(text) } catch {
      return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: ['Non-JSON response from AirHub'] }
    }

    console.log(`[AIRHUB_GET_PLANS_RESPONSE] httpStatus=${response.status} isSuccess=${data.isSuccess}`)

    if (!response.ok) {
      return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: [`HTTP ${response.status}`] }
    }
    if (data.isSuccess === false) {
      return { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 1, errors: [`AirHub rejected: ${data.message || 'unknown'}`] }
    }

    const plans = data.getInformation || []
    console.log(`[AIRHUB_GET_PLANS_RESPONSE] planCount=${plans.length}`)

    // Idempotent import
    let created = 0, updated = 0, skipped = 0, failed = 0
    const errors: string[] = []

    for (const plan of plans) {
      try {
        const planCode = plan.planCode
        if (!planCode) { skipped++; continue }

        const capacityVal = parseFloat(plan.capacity || '0')
        const unit = (plan.capacityUnit || 'GB').toUpperCase()
        const dataGB = unit === 'MB' ? Math.round((capacityVal / 1024) * 100) / 100
          : unit === 'KB' ? Math.round((capacityVal / 1024 / 1024) * 100) / 100
          : capacityVal

        const pkgData = {
          name: plan.planName || '',
          dataGB: Math.max(0.01, dataGB || 0.01),
          validityDays: parseInt(plan.validity || '30') || 30,
          costPrice: plan.price || 0,
          currency: plan.currency || 'USD',
          country: plan.countryName || null,
          region: plan.countryName || null,
          planType: plan.planType || null,
          providerPlanCode: planCode,
          providerRawData: plan,
          isAvailable: true,
        }

        const existing = await prisma.providerPackage.findFirst({
          where: { providerId: this.providerId, providerPlanId: planCode },
        })

        if (existing) {
          await prisma.providerPackage.update({ where: { id: existing.id }, data: pkgData })
          updated++
        } else {
          await prisma.providerPackage.create({
            data: { providerId: this.providerId, providerPlanId: planCode, ...pkgData },
          })
          created++
        }
      } catch (e: any) {
        failed++
        errors.push(`${plan.planCode || 'unknown'}: ${e.message}`)
      }
    }

    await prisma.provider.update({
      where: { id: this.providerId },
      data: { lastSyncAt: new Date(), lastSyncCount: plans.length, lastSyncResult: `Fetched ${plans.length}: ${created} created, ${updated} updated, ${failed} failed` },
    }).catch(() => {})

    console.log(`[AIRHUB_SYNC_RESULT] fetched=${plans.length} created=${created} updated=${updated} skipped=${skipped} failed=${failed}`)
    return { fetched: plans.length, created, updated, skipped, failed, errors: errors.slice(0, 10) }
  }
}
