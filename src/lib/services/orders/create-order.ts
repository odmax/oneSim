import { prisma } from '@/lib/prisma'
import { providerRouter } from '@/lib/services/providers/router'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'

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
    status: string
    qrCodeUrl?: string | null
  }>
  error?: string
  errorStatus?: number
}

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
  const totalAmount = parseFloat(pkg.priceUSD.toString()) * quantity
  if (parseFloat(business.walletBalance.toString()) < totalAmount) {
    return { success: false, error: 'Insufficient wallet balance', errorStatus: 402 }
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

  // Route to provider
  const providerResult = await providerRouter.routeOrder({
    businessId,
    customerId: customerId || 'unknown',
    customerName: customer?.name || 'Business Order',
    customerEmail: customer?.email || '',
    packageId: pkg.id,
    quantity,
  })

  if (!providerResult.success) {
    return { success: false, error: providerResult.error || 'Provider activation failed', errorStatus: 502 }
  }

  const displayName = pkg.displayName || pkg.name

  // Create order with real ICCIDs from provider
  const result = await prisma.$transaction(async (tx) => {
    const purchase = await tx.eSIMPurchase.create({
      data: {
        businessId,
        userId,
        packageId: pkg.id,
        quantity,
        totalAmount,
        status: 'PENDING_ACTIVATION',
        providerStatus: providerResult.providerStatus || 'PENDING',
        providerResponse: providerResult as any,
        callbackUrl: callbackUrl || null,
      },
    })

    const esims = []
    for (let i = 0; i < quantity; i++) {
      const providerEsim = providerResult.esims?.[i]
      const esim = await tx.eSIM.create({
        data: {
          purchaseId: purchase.id,
          customerId: customerId || null,
          iccid: providerEsim?.iccid || `PENDING-${Date.now()}-${i}`,
          qrCodeUrl: providerEsim?.qrCodeUrl || null,
          status: 'PENDING_ACTIVATION',
          providerStatus: 'PENDING',
          expiresAt: new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000),
        },
      })
      esims.push(esim)
    }

    await tx.business.update({
      where: { id: businessId },
      data: { walletBalance: { decrement: totalAmount } },
    })

    await tx.walletTransaction.create({
      data: {
        businessId,
        amount: -totalAmount,
        type: 'PURCHASE',
        description: customer
          ? `Order: ${quantity}x ${displayName} for ${customer.email}`
          : `Purchased ${quantity}x ${displayName}`,
      },
    })

    await tx.invoice.create({
      data: { businessId, purchaseId: purchase.id, amount: totalAmount, status: 'PAID', paidAt: new Date() },
    })

    await tx.auditLog.create({
      data: {
        userId,
        action: 'PURCHASE_ESIM',
        entity: 'ESIMPurchase',
        entityId: purchase.id,
        details: customer
          ? `Order placed: ${quantity}x ${displayName} for ${customer.email} at $${totalAmount}`
          : `Purchased ${quantity}x ${displayName} for $${totalAmount}`,
      },
    })

    return { purchase, esims }
  })

  const unitPrice = parseFloat(pkg.priceUSD.toString())

  return {
    success: true,
    orderId: result.purchase.id,
    customerId,
    status: result.purchase.status,
    unitCost: unitPrice,
    totalCost: totalAmount,
    quantity,
    currency: pkg.currency || 'USD',
    esims: result.esims.map((e) => ({
      id: e.id,
      iccid: e.iccid,
      status: e.status,
      qrCodeUrl: e.qrCodeUrl,
    })),
  }
}
