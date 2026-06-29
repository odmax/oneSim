import { prisma } from '@/lib/prisma'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { createTimelineEvent, transitionOrder } from './order-state-machine'
import { initiateAndFulfillPurchase } from './provider-purchase'

export interface CreateOrderCustomer {
  name: string
  email: string
  phone?: string
  country?: string
  externalId?: string
}

export interface CreateOrderParams {
  businessId: string
  userId: string
  packageId?: string
  sku?: string
  packageCode?: string
  quantity: number
  customer?: CreateOrderCustomer
  callbackUrl?: string
}

export interface CreateOrderResult {
  success: boolean
  orderId?: string
  customerId?: string
  status?: string
  unitCost?: number
  totalCost?: number
  quantity?: number
  currency?: string
  esims?: Array<{
    id: string
    iccid: string
    imsi?: string | null
    activationCode?: string | null
    status: string
    qrCodeUrl?: string | null
  }>
  error?: string
  errorStatus?: number
}

const DUP_WINDOW_MS = 30_000

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const { businessId, userId, packageId, sku, packageCode, quantity, customer, callbackUrl } = params

  if (quantity < 1 || quantity > 100) {
    return { success: false, error: 'quantity must be between 1 and 100', errorStatus: 400 }
  }

  // Resolve package
  const resolution = await resolvePackageIdentifier({ packageId, sku, packageCode })
  if (!resolution) {
    return { success: false, error: 'Package not found or inactive', errorStatus: 404 }
  }

  const pkg = resolution.package

  if (pkg.source === 'PROVIDER_PLAN') {
    return { success: false, error: 'Package not available for purchase', errorStatus: 404 }
  }

  // Check business
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) {
    return { success: false, error: 'Business not found', errorStatus: 404 }
  }
  if (business.status === 'SUSPENDED') {
    return { success: false, error: 'Business account is suspended', errorStatus: 403 }
  }

  // Check wallet
  const unitPrice = parseFloat(pkg.priceUSD.toString())
  const totalAmount = unitPrice * quantity
  if (parseFloat(business.walletBalance.toString()) < totalAmount) {
    return { success: false, error: 'Insufficient wallet balance', errorStatus: 402 }
  }

  // Idempotency: reject duplicate orders within 30s
  const recent = await prisma.eSIMPurchase.findFirst({
    where: {
      businessId,
      packageId: pkg.id,
      quantity,
      totalAmount,
      createdAt: { gte: new Date(Date.now() - DUP_WINDOW_MS) },
      status: { notIn: ['FAILED', 'CANCELLED', 'REFUNDED'] },
    },
  })
  if (recent) {
    return {
      success: true,
      orderId: recent.id,
      status: recent.status,
      unitCost: unitPrice,
      totalCost: totalAmount,
      quantity,
      currency: pkg.currency || 'USD',
    }
  }

  // Find or create customer
  let customerId: string | undefined
  if (customer) {
    let dbCustomer = await prisma.customer.findFirst({
      where: { businessId, email: customer.email },
    })

    if (dbCustomer) {
      dbCustomer = await prisma.customer.update({
        where: { id: dbCustomer.id },
        data: {
          name: customer.name,
          phone: customer.phone || dbCustomer.phone,
          country: customer.country || dbCustomer.country,
        },
      })
    } else {
      dbCustomer = await prisma.customer.create({
        data: {
          businessId,
          name: customer.name,
          email: customer.email,
          phone: customer.phone || null,
          country: customer.country || 'Unknown',
        },
      })
    }
    customerId = dbCustomer.id
  }

  const displayName = pkg.displayName || pkg.name

  const packageSnapshot = {
    packageId: pkg.id,
    sku: pkg.sku,
    packageCode: pkg.packageCode,
    displayName,
    customerDescription: pkg.customerDescription || null,
    dataGB: pkg.dataGB,
    validityDays: pkg.validityDays,
    priceUSD: unitPrice,
    localPrice: parseFloat(pkg.localPrice.toString()),
    currency: pkg.currency || 'USD',
    source: pkg.source,
    providerId: pkg.providerId,
    providerPlanId: pkg.providerPlanId || null,
    providerName: pkg.providerName || null,
    purchasedAt: new Date().toISOString(),
  }

  // Create order in CREATED status
  let orderId: string

  try {
    const order = await prisma.eSIMPurchase.create({
      data: {
        businessId,
        userId,
        packageId: pkg.id,
        quantity,
        totalAmount,
        status: 'CREATED',
        callbackUrl: callbackUrl || null,
        packageSnapshot: packageSnapshot as any,
        packageName: displayName,
        packageDataGB: pkg.dataGB,
        packageValidityDays: pkg.validityDays,
        packageUnitPrice: unitPrice,
        packageCurrency: pkg.currency || 'USD',
      },
    })
    orderId = order.id
  } catch (e: any) {
    return { success: false, error: 'Failed to create order', errorStatus: 500 }
  }

  await createTimelineEvent(orderId, { eventType: 'ORDER_CREATED', message: `Order created: ${quantity}x ${displayName}` })
  await transitionOrder(orderId, 'CREATED')

  // Dispatch to provider via purchase service
  const purchase = await initiateAndFulfillPurchase(orderId, { totalAmount, packageSnapshot }, {
    businessId,
    userId,
    customerId,
    customerName: customer?.name,
    customerEmail: customer?.email,
    packageId: pkg.id,
    quantity,
  })

  if (!purchase.success) {
    // Fire failure webhook
    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        await enqueueBusinessWebhooks(businessId, 'order.failed', {
          orderId,
          packageId: pkg.id,
          packageName: displayName,
          quantity,
          error: purchase.error,
        })
      } catch { }
    })()

    return { success: false, error: purchase.error || 'Purchase failed', errorStatus: purchase.errorStatus || 502 }
  }

  // Fire success webhook
  ;(async () => {
    try {
      const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
      await enqueueBusinessWebhooks(businessId, 'order.completed', {
        orderId,
        packageId: pkg.id,
        packageName: displayName,
        quantity,
        totalAmount,
        currency: pkg.currency || 'USD',
        customer: customer ? { name: customer.name, email: customer.email } : null,
        esims: purchase.esims?.map(e => ({ id: undefined, iccid: e.iccid })) || [],
      })
      await enqueueBusinessWebhooks(businessId, 'esim.provisioned', {
        orderId,
        quantity,
        esims: purchase.esims?.map(e => ({ id: undefined, iccid: e.iccid, status: 'PENDING_ACTIVATION' })) || [],
      })
    } catch { }
  })()

  // Load created eSIMs for response
  const createdESIMs = await prisma.eSIM.findMany({
    where: { purchaseId: orderId },
    select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true },
  })

  return {
    success: true,
    orderId,
    customerId,
    status: 'FULFILLED',
    unitCost: unitPrice,
    totalCost: totalAmount,
    quantity,
    currency: pkg.currency || 'USD',
    esims: createdESIMs.map(e => ({
      id: e.id,
      iccid: e.iccid,
      imsi: e.imsi,
      activationCode: e.activationCode,
      status: e.status,
      qrCodeUrl: e.qrCodeUrl,
    })),
  }
}
