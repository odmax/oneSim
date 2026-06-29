'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { createTimelineEvent, transitionOrder, failOrder } from '@/lib/services/orders/order-state-machine'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from '@/lib/services/orders/wallet-actions'
import { getAdapterForType, isProviderOperational } from '@/lib/providers/adapter-manager'

export interface TestPurchaseResult {
  success: boolean
  orderId?: string
  status?: string
  esims?: Array<{ iccid: string; imsi?: string | null; activationCode?: string | null; qrCodeUrl?: string | null }>
  providerResponse?: any
  timeline?: Array<{ eventType: string; message?: string; createdAt: Date }>
  error?: string
  errorStep?: string
}

export async function testProviderPurchase(providerId: string, packageId: string, quantity: number): Promise<TestPurchaseResult> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  // Find provider
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }
  if (!isProviderOperational(provider.status)) return { success: false, error: `Provider is ${provider.status}` }

  // Find test business (first active business)
  const business = await prisma.business.findFirst({
    where: { status: 'APPROVED' },
    orderBy: { createdAt: 'asc' },
  })
  if (!business) return { success: false, error: 'No active business found for test' }

  // Find package
  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
  if (!pkg) return { success: false, error: 'Package not found' }

  const unitPrice = parseFloat(pkg.priceUSD.toString())
  const totalAmount = unitPrice * quantity
  const displayName = pkg.displayName || pkg.name

  const timeline: Array<{ eventType: string; message?: string; createdAt: Date }> = []
  const addTimeline = (eventType: string, message?: string) => timeline.push({ eventType, message, createdAt: new Date() })

  // 1. Create order
  let orderId: string
  try {
    const order = await prisma.eSIMPurchase.create({
      data: {
        businessId: business.id,
        userId: session.user.id,
        packageId: pkg.id,
        quantity,
        totalAmount,
        status: 'CREATED',
        packageSnapshot: { packageId: pkg.id, displayName, dataGB: pkg.dataGB, validityDays: pkg.validityDays, priceUSD: unitPrice } as any,
        packageName: displayName,
        packageDataGB: pkg.dataGB,
        packageValidityDays: pkg.validityDays,
        packageUnitPrice: unitPrice,
        packageCurrency: pkg.currency || 'USD',
      },
    })
    orderId = order.id
  } catch (e: any) {
    return { success: false, error: `Failed to create order: ${e.message}`, errorStep: 'create_order' }
  }

  await createTimelineEvent(orderId, { eventType: 'ORDER_CREATED', message: `Test: ${quantity}x ${displayName}` })
  await transitionOrder(orderId, 'CREATED')
  addTimeline('ORDER_CREATED', `Test order created: ${quantity}x ${displayName}`)

  // 2. Reserve wallet
  const reserve = await reserveWalletFunds(orderId, business.id, totalAmount)
  if (!reserve.success) {
    await failOrder(orderId, `Wallet reserve failed: ${reserve.error}`)
    addTimeline('FAILED', reserve.error)
    return { success: false, error: reserve.error, errorStep: 'reserve_wallet', orderId, timeline }
  }
  await transitionOrder(orderId, 'PAYMENT_RESERVED')
  addTimeline('WALLET_RESERVED', `Reserved $${totalAmount}`)

  // 3. Dispatch to provider
  await transitionOrder(orderId, 'PENDING_PROVIDER')
  addTimeline('PROVIDER_DISPATCH', `Dispatching to ${provider.name}`)

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerId: provider.id },
  })
  addTimeline('PROVIDER_SELECTED', `Provider: ${provider.name}`)

  const adapter = await getAdapterForType(provider.type, {
    apiBaseUrl: provider.apiBaseUrl,
    apiToken: provider.apiToken,
    providerId: provider.id,
    environment: provider.environment,
    authUrl: provider.authUrl,
  })

  const planId = pkg.providerPlanId || pkg.id

  let providerResponse: any
  try {
    const result = await adapter.activateESIM({
      planId,
      quantity,
      subscriber: { email: 'test@onetelecom.cloud', first_name: 'Test', last_name: 'User' },
      activationType: 'ACTIVATE_NOW',
      externalId: business.id,
    })

    if (!result.success || !result.data) {
      await releaseReservedFunds(orderId, business.id, totalAmount)
      await failOrder(orderId, result.error?.message || 'Provider activation failed', { message: result.error?.message })
      addTimeline('PROVIDER_FAILED', result.error?.message || 'Activation failed')
      return {
        success: false, error: result.error?.message || 'Provider activation failed',
        errorStep: 'provider_dispatch', orderId, timeline,
        providerResponse: { error: result.error },
      }
    }

    providerResponse = result.data
  } catch (e: any) {
    await releaseReservedFunds(orderId, business.id, totalAmount)
    await failOrder(orderId, `Provider error: ${e.message}`, { message: e.message })
    addTimeline('PROVIDER_FAILED', e.message)
    return { success: false, error: `Provider error: ${e.message}`, errorStep: 'provider_dispatch', orderId, timeline }
  }

  const providerOrderId = providerResponse?.activationId || providerResponse?.providerOrderId || null
  const providerStatus = providerResponse?.status || 'ACTIVE'

  // 4. Map response to standardized fields
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
    await releaseReservedFunds(orderId, business.id, totalAmount)
    await failOrder(orderId, 'Provider returned incomplete ICCID data')
    addTimeline('PROVIDER_FAILED', 'Missing ICCID in provider response')
    return { success: false, error: 'Provider returned incomplete ICCID data', errorStep: 'map_response', orderId, timeline, providerResponse }
  }

  // 5. Save eSIM records
  for (const esim of esims) {
    await prisma.eSIM.create({
      data: {
        purchaseId: orderId,
        iccid: esim.iccid,
        imsi: esim.imsi || null,
        activationCode: esim.activationCode || null,
        qrCodeUrl: esim.qrCodeUrl || null,
        status: 'PENDING_ACTIVATION',
        providerActivationId: providerOrderId,
        providerStatus: 'PENDING',
        expiresAt: new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000),
        packageSnapshot: { packageId: pkg.id, displayName, dataGB: pkg.dataGB, validityDays: pkg.validityDays } as any,
        packageName: displayName,
        packageDataGB: pkg.dataGB,
        packageValidityDays: pkg.validityDays,
      },
    })
  }
  addTimeline('ESIMS_CREATED', `${esims.length} eSIMs saved`)

  // 6. Capture wallet
  await captureReservedFunds(orderId, business.id, totalAmount)

  // 7. Mark fulfilled
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerFulfillId: providerOrderId, providerStatus },
  })
  await transitionOrder(orderId, 'FULFILLED')
  addTimeline('FULFILLED', 'Purchase completed successfully')

  return {
    success: true,
    orderId,
    status: 'FULFILLED',
    esims,
    providerResponse,
    timeline,
  }
}

export async function cleanupTestOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { esims: true },
  })
  if (!order) return { success: false, error: 'Order not found' }

  // Delete eSIMs first
  await prisma.eSIM.deleteMany({ where: { purchaseId: orderId } })
  // Delete timeline events
  await prisma.orderTimelineEvent.deleteMany({ where: { orderId } })
  // Delete order
  await prisma.eSIMPurchase.delete({ where: { id: orderId } })

  return { success: true }
}
