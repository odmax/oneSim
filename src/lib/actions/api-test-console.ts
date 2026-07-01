'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { providerRouter } from '@/lib/services/providers/router'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { getAppUrl } from '@/lib/config/urls'
import crypto from 'crypto'

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export async function testApiOrder(formData: FormData): Promise<{
  success: boolean
  status?: number
  body?: any
  curl?: string
  error?: string
}> {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    return { success: false, error: 'Unauthorized. Business User session required.' }
  }

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
  })

  if (!businessUser) {
    return { success: false, error: 'Only Business Admins can use the test console.' }
  }

  const businessId = session.user.businessId!
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business || business.status !== 'APPROVED') {
    return { success: false, error: 'Business account is not approved.' }
  }

  try {
    const customerName = formData.get('customerName') as string
    const customerEmail = formData.get('customerEmail') as string
    const customerPhone = formData.get('customerPhone') as string
    const country = formData.get('country') as string
    const packageId = formData.get('packageId') as string
    const sku = formData.get('sku') as string
    const packageCode = formData.get('packageCode') as string
    const quantity = parseInt(formData.get('quantity') as string) || 1
    const externalCustomerId = formData.get('externalCustomerId') as string
    const apiKeyPrefix = formData.get('apiKeyPrefix') as string

    if (!customerName || !customerEmail) {
      return { success: false, error: 'customerName and customerEmail are required.' }
    }

    if (!packageId && !sku && !packageCode) {
      return { success: false, error: 'One of packageId, sku, or packageCode is required.' }
    }

    const resolution = await resolvePackageIdentifier({ packageId, sku, packageCode })
    if (!resolution) {
      return { success: false, error: 'Package not found or inactive.' }
    }

    const pkg = resolution.package

    const totalAmount = parseFloat(pkg.priceUSD.toString()) * quantity
    if (parseFloat(business.walletBalance.toString()) < totalAmount) {
      return { success: false, error: 'Insufficient wallet balance.' }
    }

    let customer = await prisma.customer.findFirst({ where: { businessId, email: customerEmail } })

    if (customer) {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: { name: customerName, phone: customerPhone || customer.phone, country: country || customer.country },
      })
    } else {
      customer = await prisma.customer.create({
        data: { businessId, name: customerName, email: customerEmail, phone: customerPhone, country: country || 'Unknown' },
      })
    }

    const providerResult = await providerRouter.routeOrder({
      businessId,
      customerId: customer.id,
      customerName,
      customerEmail,
      packageId,
      quantity,
    })

    if (!providerResult.success) {
      return { success: false, status: 502, body: { success: false, error: providerResult.error || 'Provider activation failed' } }
    }

    const result = await prisma.$transaction(async (tx) => {
      const purchase = await tx.eSIMPurchase.create({
        data: {
          businessId,
          userId: businessUser.userId,
          packageId,
          quantity,
          totalAmount,
          status: 'PENDING_ACTIVATION',
          providerStatus: providerResult.providerStatus || 'PENDING',
          providerResponse: providerResult as any,
        },
      })

      const esims = []
      for (let i = 0; i < quantity; i++) {
        const providerEsim = providerResult.esims?.[i]
        const esim = await tx.eSIM.create({
          data: {
            purchaseId: purchase.id,
            customerId: customer.id,
            iccid: providerEsim?.iccid || `API-${Date.now()}-${i}`,
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
          description: `Test console order: ${quantity}x ${pkg.name} for ${customerEmail}`,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'TEST_CONSOLE_ORDER',
          entity: 'ESIMPurchase',
          entityId: purchase.id,
          details: `Test console order: ${quantity}x ${pkg.name} via ${pkg.providerName || 'MOCK'}`,
        },
      })

      return { purchase, esims }
    })

    const responseBody = {
      success: true,
      orderId: result.purchase.id,
      customerId: customer.id,
      status: result.purchase.status,
      esims: result.esims.map(e => ({
        id: e.id,
        iccid: e.iccid,
        status: e.status,
        qrCodeUrl: e.qrCodeUrl,
      })),
    }

    // Look up API key id for logging
    let apiKeyId: string | undefined
    if (apiKeyPrefix) {
      const keyRecord = await prisma.businessApiKey.findFirst({
        where: { keyPrefix: apiKeyPrefix, businessId, status: 'ACTIVE' },
      })
      if (keyRecord) apiKeyId = keyRecord.id
    }

    const testConsoleStartTime = Date.now()

    // Log the API request as if it came through /api/v1
    prisma.apiRequestLog.create({
      data: {
        businessId,
        apiKeyId: apiKeyId || null,
        method: 'POST',
        path: '/api/v1/esims/order',
        statusCode: 200,
        durationMs: Date.now() - testConsoleStartTime,
        ipAddress: '127.0.0.1',
        userAgent: 'TestConsole',
        idempotencyKey: null,
        errorMessage: null,
      },
    }).catch(() => {})

    const identifierKey = resolution.resolvedBy
    const identifierValue = resolution.identifier
    const curl = `curl -X POST ${getAppUrl()}/api/v1/esims/order \\
  -H "Authorization: Bearer ${apiKeyPrefix || 'ONESIM_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: unique-request-id-123" \\
  -d '${JSON.stringify({
    customerName,
    customerEmail,
    customerPhone: customerPhone || undefined,
    country: country || undefined,
    [identifierKey]: identifierValue,
    quantity,
    ...(externalCustomerId ? { externalCustomerId } : {}),
  }, null, 2)}'`

    return { success: true, status: 200, body: responseBody, curl }
  } catch (error: any) {
    console.error('Test console error:', error)
    return { success: false, error: error.message || 'Internal server error' }
  }
}

export async function testVerifyApiKey(): Promise<{
  success: boolean
  businessId?: string
  businessName?: string
  error?: string
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return { success: false, error: 'Unauthorized' }
  }
  return {
    success: true,
    businessId: session.user.businessId || undefined,
    businessName: session.user.businessName || undefined,
  }
}

export async function testListPackages(): Promise<{
  success: boolean
  packages?: Array<{
    id: string
    displayName: string | null
    name: string
    dataGB: number
    validityDays: number
    priceUSD: string
    customerDescription: string | null
    sku: string | null
    packageCode: string | null
  }>
  error?: string
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return { success: false, error: 'Unauthorized' }
  }

  const packages = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    orderBy: { priceUSD: 'asc' },
    select: {
      id: true,
      displayName: true,
      name: true,
      dataGB: true,
      validityDays: true,
      priceUSD: true,
      customerDescription: true,
      sku: true,
      packageCode: true,
    },
  })

  return {
    success: true,
    packages: packages.map(p => ({
      ...p,
      priceUSD: p.priceUSD.toString(),
    })),
  }
}
