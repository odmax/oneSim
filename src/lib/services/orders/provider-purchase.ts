import { prisma } from '@/lib/prisma'
import { getAdapterForType, isProviderOperational } from '@/lib/providers/adapter-manager'
import { createTimelineEvent, transitionOrder, failOrder } from './order-state-machine'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from './wallet-actions'

interface PurchaseParams {
  businessId: string
  userId: string
  customerId?: string | null
  customerName?: string
  customerEmail?: string
  packageId: string
  quantity: number
}

interface ProviderSelection {
  providerId: string
  providerName: string
  adapter: any
  planId: string
}

export interface MappedESIMData {
  iccid: string
  imsi?: string | null
  activationCode?: string | null
  qrCodeUrl?: string | null
  smdpAddress?: string | null
  matchingId?: string | null
  providerOrderId?: string | null
}

export interface PurchaseResult {
  success: boolean
  orderId?: string
  esims?: MappedESIMData[]
  providerReservationId?: string
  providerFulfillId?: string
  providerStatus?: string
  error?: string
  errorStatus?: number
}

function extractString(raw: any): string | null {
  if (raw == null) return null
  return String(raw)
}

function mapProviderResponse(data: any, index: number): MappedESIMData {
  const iccid =
    extractString(data.iccids?.[index]) ||
    extractString(data.iccid) ||
    extractString(data.esims?.[index]?.iccid) ||
    extractString(data.imsis?.[index])?.replace(/[^0-9]/g, '') ||
    ''

  return {
    iccid,
    imsi: extractString(data.imsis?.[index]),
    activationCode: extractString(data.activationCodes?.[index]) || extractString(data.activationCode),
    qrCodeUrl: extractString(data.qrCodeUrl) || extractString(data.qrCodeUrls?.[index]),
    smdpAddress: extractString(data.smdpAddress) || extractString(data.smdpAddresses?.[index]),
    matchingId: extractString(data.matchingId) || extractString(data.matchingIds?.[index]),
    providerOrderId: extractString(data.providerOrderId) || extractString(data.activationId),
  }
}

async function selectProvider(pkg: any): Promise<{ success: boolean; selection?: ProviderSelection; error?: string }> {
  let providerId = pkg.providerId

  if (!providerId) {
    const operational = await prisma.provider.findMany({
      where: { status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] } },
      orderBy: { priority: 'asc' },
      take: 1,
    })
    if (operational.length === 0) return { success: false, error: 'No operational provider available' }
    providerId = operational[0].id
  }

  const dbProvider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!dbProvider) return { success: false, error: 'Provider not found' }
  if (!isProviderOperational(dbProvider.status)) return { success: false, error: `Provider is ${dbProvider.status}` }

  const adapter = await getAdapterForType(dbProvider.type, {
    apiBaseUrl: dbProvider.apiBaseUrl,
    apiToken: dbProvider.apiToken,
    providerId: dbProvider.id,
    environment: dbProvider.environment,
    authUrl: dbProvider.authUrl,
  })

  const planId = pkg.providerPlanId || pkg.id

  return {
    success: true,
    selection: { providerId: dbProvider.id, providerName: dbProvider.name, adapter, planId },
  }
}

async function dispatchPurchase(selection: ProviderSelection, params: PurchaseParams): Promise<{ success: boolean; data?: any; error?: string }> {
  const { adapter, planId } = selection
  const nameParts = (params.customerName || 'Business Order').trim().split(/\s+/)

  try {
    const result = await adapter.activateESIM({
      planId,
      quantity: params.quantity,
      subscriber: {
        email: params.customerEmail || '',
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || undefined,
      },
      activationType: 'ACTIVATE_NOW',
      externalId: params.businessId,
    })

    if (!result.success || !result.data) {
      const msg = result.error?.message || 'Provider activation failed'
      return { success: false, error: msg }
    }

    return { success: true, data: result.data }
  } catch (e: any) {
    return { success: false, error: `Provider error: ${e.message || 'Unknown error'}` }
  }
}

async function saveESIMs(orderId: string, esims: MappedESIMData[], customerId: string | null, packageSnapshot: any, validityDays: number) {
  for (const esim of esims) {
    await prisma.eSIM.create({
      data: {
        purchaseId: orderId,
        customerId: customerId || null,
        iccid: esim.iccid,
        imsi: esim.imsi || null,
        activationCode: esim.activationCode || null,
        qrCodeUrl: esim.qrCodeUrl || null,
        status: 'PENDING_ACTIVATION',
        providerActivationId: esim.providerOrderId || null,
        providerStatus: 'PENDING',
        expiresAt: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
        packageSnapshot: packageSnapshot as any,
        packageName: packageSnapshot.displayName,
        packageDataGB: packageSnapshot.dataGB,
        packageValidityDays: packageSnapshot.validityDays,
      },
    })
  }
}

export async function initiateAndFulfillPurchase(orderId: string, order: any, params: PurchaseParams): Promise<PurchaseResult> {
  const totalAmount = Number(order.totalAmount)

  // 1. Reserve wallet funds
  const reserve = await reserveWalletFunds(orderId, params.businessId, totalAmount)
  if (!reserve.success) {
    await failOrder(orderId, `Wallet reserve failed: ${reserve.error}`)
    await createTimelineEvent(orderId, { eventType: 'PURCHASE_FAILED', message: reserve.error })
    return { success: false, error: reserve.error, errorStatus: 402 }
  }
  await transitionOrder(orderId, 'PAYMENT_RESERVED')

  // 2. Transition to pending provider
  await transitionOrder(orderId, 'PENDING_PROVIDER')
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_DISPATCH', message: 'Dispatching to provider' })

  // 3. Select provider
  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: params.packageId } })
  if (!pkg) {
    await releaseReservedFunds(orderId, params.businessId, totalAmount)
    await failOrder(orderId, 'Package not found')
    return { success: false, error: 'Package not found', errorStatus: 404 }
  }

  const selection = await selectProvider(pkg)
  if (!selection.success || !selection.selection) {
    await releaseReservedFunds(orderId, params.businessId, totalAmount)
    await failOrder(orderId, selection.error || 'No provider available')
    await createTimelineEvent(orderId, { eventType: 'PROVIDER_FAILED', message: selection.error })
    return { success: false, error: selection.error || 'No provider available', errorStatus: 502 }
  }

  const { selection: sel } = selection

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerId: sel.providerId },
  })
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_SELECTED', message: `Provider: ${sel.providerName}` })

  // 4. Dispatch purchase
  const dispatch = await dispatchPurchase(sel, params)
  if (!dispatch.success || !dispatch.data) {
    await releaseReservedFunds(orderId, params.businessId, totalAmount)
    await failOrder(orderId, dispatch.error || 'Provider activation failed', { message: dispatch.error })
    await createTimelineEvent(orderId, { eventType: 'PROVIDER_FAILED', message: dispatch.error })
    return { success: false, error: dispatch.error || 'Provider activation failed', errorStatus: 502 }
  }

  const providerData = dispatch.data
  const providerOrderId = extractString(providerData.activationId) || undefined
  const providerStatus = providerData.status || 'ACTIVE'
  const reservationId = extractString(providerData.reservationId) || undefined

  // 5. Handle two-step reservation state
  if (reservationId && (!providerData.iccids || providerData.iccids.length === 0)) {
    // Reservation created but no ICCIDs yet — order is reserved, not fulfilled
    await prisma.eSIMPurchase.update({
      where: { id: orderId },
      data: {
        providerId: sel.providerId,
        providerReservationId: reservationId,
        providerStatus: 'RESERVED',
      },
    })
    await transitionOrder(orderId, 'RESERVED')
    await createTimelineEvent(orderId, { eventType: 'PROVIDER_RESERVATION_CREATED', message: `Reservation: ${reservationId} at ${sel.providerName}` })
    return {
      success: true,
      orderId,
      esims: [],
      providerReservationId: reservationId,
      providerFulfillId: undefined,
      providerStatus: 'RESERVED',
    }
  }

  // 6. Map response to standardized fields
  const esims: MappedESIMData[] = []
  for (let i = 0; i < params.quantity; i++) {
    esims.push(mapProviderResponse(providerData, i))
  }

  const missingIccid = esims.some(e => !e.iccid)
  if (missingIccid) {
    // If we have a reservation, try to cancel it before failing
    if (reservationId) {
      await cancelPurchase(orderId, params.businessId, totalAmount).catch(() => {})
    }
    await releaseReservedFunds(orderId, params.businessId, totalAmount)
    await failOrder(orderId, 'Provider returned incomplete ICCID data')
    await createTimelineEvent(orderId, { eventType: 'PROVIDER_FAILED', message: 'Missing ICCID in response' })
    return { success: false, error: 'Provider returned incomplete data', errorStatus: 502 }
  }

  // 7. Save eSIM records
  const packageSnapshot = order.packageSnapshot || {}
  await saveESIMs(orderId, esims, params.customerId || null, packageSnapshot, pkg.validityDays)

  // 8. Capture wallet funds
  await captureReservedFunds(orderId, params.businessId, totalAmount)

  // 9. Mark order as fulfilled
  const updateData: any = {
    providerFulfillId: providerOrderId || null,
    providerStatus,
  }
  if (reservationId) updateData.providerReservationId = reservationId
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: updateData,
  })
  await transitionOrder(orderId, 'FULFILLED')
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_FULFILLED', message: `Provider: ${sel.providerName}, Reference: ${providerOrderId || 'N/A'}` })

  return {
    success: true,
    orderId,
    esims,
    providerReservationId: reservationId,
    providerFulfillId: providerOrderId,
    providerStatus,
  }
}

export async function cancelPurchase(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }

  const cancellable = ['CREATED', 'PAYMENT_RESERVED', 'RESERVED', 'FULFILLED']
  if (!cancellable.includes(order.status)) {
    return { success: false, error: `Cannot cancel order in status ${order.status}` }
  }

  await releaseReservedFunds(orderId, businessId, amount)
  await transitionOrder(orderId, 'CANCELLED')
  await createTimelineEvent(orderId, { eventType: 'CANCELLED', message: 'Order cancelled' })
  return { success: true }
}

export async function getPurchaseUsage(iccid: string, providerId: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const dbProvider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!dbProvider) return { success: false, error: 'Provider not found' }

    const adapter = await getAdapterForType(dbProvider.type, {
      apiBaseUrl: dbProvider.apiBaseUrl,
      apiToken: dbProvider.apiToken,
      providerId: dbProvider.id,
      environment: dbProvider.environment,
    })

    const result = await adapter.getUsage(iccid)
    if (!result.success) return { success: false, error: result.error?.message || 'Usage fetch failed' }
    return { success: true, data: result.data }
  } catch (e: any) {
    return { success: false, error: e.message || 'Usage fetch error' }
  }
}

export async function topUpPurchase(orderId: string, iccid: string, planId: string, quantity: number, businessId: string): Promise<{ success: boolean; data?: any; error?: string }> {
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }

  const dbProvider = await prisma.provider.findUnique({ where: { id: order.providerId! } })
  if (!dbProvider) return { success: false, error: 'Provider not found' }

  const adapter = await getAdapterForType(dbProvider.type, {
    apiBaseUrl: dbProvider.apiBaseUrl,
    apiToken: dbProvider.apiToken,
    providerId: dbProvider.id,
    environment: dbProvider.environment,
  })

  try {
    const result = await adapter.topUpESIM({ iccid, planId, quantity })
    if (!result.success) return { success: false, error: result.error?.message || 'Top-up failed' }

    await createTimelineEvent(orderId, { eventType: 'TOPUP', message: `Top-up: ${quantity}x ${planId}` })
    return { success: true, data: result.data }
  } catch (e: any) {
    return { success: false, error: e.message || 'Top-up error' }
  }
}
