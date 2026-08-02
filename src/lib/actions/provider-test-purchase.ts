'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { getAdapterForType, isProviderOperational } from '@/lib/providers/adapter-manager'
import { resolveConnectorType } from '@/lib/providers/connectors/connector-factory'
import { requiresTravelDateForPackage, isValidTravelDate } from '@/lib/providers/travel-date-utils'

export interface TestPurchaseResult {
  success: boolean
  esims?: Array<{ iccid: string; imsi?: string | null; activationCode?: string | null; qrCodeUrl?: string | null }>
  providerResponse?: any
  timeline?: Array<{ eventType: string; message?: string; createdAt: Date }>
  error?: string
  errorStep?: string
  diagnostics?: {
    providerPackageId: string
    providerPlanId: string
    providerPackageName: string
    providerId: string
    quantity: number
    travelDate?: string
    requiresTravelDate?: boolean
  }
}

export async function testProviderPurchase(providerId: string, providerPackageId: string, quantity: number, travelDate?: string): Promise<TestPurchaseResult> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  // 1. Find provider
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found', errorStep: 'provider_lookup' }

  const { providerSupports } = await import('@/lib/providers/capabilities/registry')
  if (!providerSupports(provider, 'PURCHASE')) {
    return { success: false, error: 'This provider does not support Purchase.', errorStep: 'provider_lookup' }
  }
  if (!isProviderOperational(provider.status)) {
    return { success: false, error: `Provider is ${provider.status}`, errorStep: 'provider_lookup' }
  }

  // 2. Find provider package — scoped to this provider
  const pkg = await prisma.providerPackage.findFirst({
    where: { id: providerPackageId, providerId },
  })
  if (!pkg) {
    return { success: false, error: 'Provider package not found', errorStep: 'package_lookup' }
  }

  // 3. Resolve provider-facing plan identifier (not the DB primary key)
  const planId = pkg.providerPlanId || pkg.providerPlanCode || ''
  if (!planId) {
    return { success: false, error: 'Provider package has no provider-facing plan identifier (providerPlanId). Cannot dispatch.', errorStep: 'package_lookup' }
  }

  // 3a. Validate travel date requirement before any provider dispatch.
  const requiresTravelDate = requiresTravelDateForPackage(pkg)
  const normalizedTravelDate = travelDate !== undefined && travelDate !== null && travelDate.trim() !== '' ? travelDate.trim() : undefined
  if (normalizedTravelDate !== undefined && !isValidTravelDate(normalizedTravelDate)) {
    return {
      success: false,
      error: `travelDate must be a valid date in YYYY-MM-DD format, got "${normalizedTravelDate}"`,
      errorStep: 'travel_date',
      diagnostics: { providerPackageId, providerPlanId: planId, providerPackageName: pkg.name, providerId, quantity, travelDate: normalizedTravelDate, requiresTravelDate },
    }
  }
  // 3b. AirHub admin test purchases always require a travel date, even when
  // synced plan metadata does not yet mark the plan as requiring one.
  const isAirHub = provider.code === 'AIRHUB' || provider.adapterStrategy === 'AIRHUB'
  const dateRequired = requiresTravelDate || isAirHub
  if (dateRequired && !normalizedTravelDate) {
    return {
      success: false,
      error: isAirHub
        ? 'Travel date is required for this AirHub test purchase.'
        : 'This package requires a Travel Date before purchase. Provide a valid date in YYYY-MM-DD format.',
      errorStep: 'travel_date',
      diagnostics: { providerPackageId, providerPlanId: planId, providerPackageName: pkg.name, providerId, quantity, requiresTravelDate },
    }
  }

  const timeline: Array<{ eventType: string; message?: string; createdAt: Date }> = []
  const addTimeline = (eventType: string, message?: string) => timeline.push({ eventType, message, createdAt: new Date() })

  const diag = { providerPackageId, providerPlanId: planId, providerPackageName: pkg.name, providerId, quantity, ...(normalizedTravelDate ? { travelDate: normalizedTravelDate } : {}), ...(requiresTravelDate ? { requiresTravelDate } : {}) }

  // 4. Resolve adapter
  const adapter = await getAdapterForType(provider.type, {
    apiBaseUrl: provider.apiBaseUrl,
    apiToken: provider.apiToken,
    providerId: provider.id,
    environment: provider.environment,
    authUrl: provider.authUrl,
  })
  addTimeline('ADAPTER_RESOLVED', `Adapter resolved for ${provider.name} (type: ${resolveConnectorType(provider.adapterStrategy, provider.type, provider.code)})`)

  // 5. Validate provider purchase configuration before dispatch
  if (adapter.validatePurchase) {
    const validation = await adapter.validatePurchase({ planId, quantity, subscriber: { email: 'test@onetelecom.cloud' } })
    if (!validation.valid) {
      addTimeline('CONFIG_VALIDATION_FAILED', validation.reason || 'Configuration invalid')
      return {
        success: false, error: `Provider configuration error: ${validation.reason}`,
        errorStep: 'config_validation', timeline,
        diagnostics: diag,
      }
    }
    addTimeline('CONFIG_VALIDATION_PASSED', 'Provider configuration is valid for purchase')
  }

  // 6. Dispatch to provider — direct connector call, no wallet or order
  addTimeline('PROVIDER_DISPATCH', `Dispatching to ${provider.name} — plan: ${planId}, quantity: ${quantity}${requiresTravelDate ? ', travel date required' : ''}`)

  let providerResponse: any
  try {
    const result = await adapter.activateESIM({
      planId,
      quantity,
      subscriber: { email: 'test@onetelecom.cloud', first_name: 'Test', last_name: 'User' },
      activationType: 'ACTIVATE_NOW',
      externalId: `admin-test-${Date.now()}`,
      ...(normalizedTravelDate ? { travelDate: normalizedTravelDate } : {}),
    } as any)

    if (!result.success || !result.data) {
      addTimeline('PROVIDER_FAILED', result.error?.message || 'Activation failed')
      return {
        success: false, error: result.error?.message || 'Provider activation failed',
        errorStep: 'provider_dispatch', timeline,
        providerResponse: { error: result.error },
        diagnostics: diag,
      }
    }

    providerResponse = result.data
    addTimeline('PROVIDER_RESPONSE_RECEIVED', 'Provider returned activation data')
  } catch (e: any) {
    addTimeline('PROVIDER_FAILED', e.message)
    return {
      success: false, error: `Provider error: ${e.message}`, errorStep: 'provider_dispatch', timeline,
      diagnostics: diag,
    }
  }

  // 7. Map response
  const extractString = (raw: any): string | null => raw == null ? null : String(raw)

  const esims: Array<{ iccid: string; imsi?: string | null; activationCode?: string | null; qrCodeUrl?: string | null }> = []
  for (let i = 0; i < quantity; i++) {
    const iccid =
      extractString(providerResponse?.iccids?.[i]) ||
      extractString(providerResponse?.iccid) ||
      extractString(providerResponse?.esims?.[i]?.iccid) ||
      extractString(providerResponse?.imsis?.[i])?.replace(/[^0-9]/g, '') ||
      ''
    esims.push({
      iccid,
      imsi: extractString(providerResponse?.imsis?.[i]),
      activationCode: extractString(providerResponse?.activationCodes?.[i]) || extractString(providerResponse?.activationCode),
      qrCodeUrl: extractString(providerResponse?.qrCodeUrl) || extractString(providerResponse?.qrCodeUrls?.[i]),
    })
  }

  const missingIccid = esims.some(e => !e.iccid)
  if (missingIccid) {
    addTimeline('PROVIDER_FAILED', 'Missing ICCID in provider response')
    return {
      success: false, error: 'Provider returned incomplete ICCID data', errorStep: 'map_response',
      providerResponse, timeline,
      diagnostics: diag,
    }
  }

  addTimeline('ESIMS_MAPPED', `${esims.length} eSIM(s) mapped from provider response`)

  return {
    success: true,
    esims,
    providerResponse,
    timeline,
    diagnostics: diag,
  }
}

export async function cleanupTestOrder(_orderId: string): Promise<{ success: boolean; error?: string }> {
  return { success: true }
}
