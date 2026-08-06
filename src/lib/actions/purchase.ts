'use server'

import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { purchaseESIMSchema } from '@/lib/validators/business'
import { createOrder } from '@/lib/services/orders/create-order'
import { createPurchaseQuote } from '@/lib/pricing/purchase-quote-service'
import { prisma } from '@/lib/prisma'

const ERROR_MAP: Record<string, string> = {
  'Package not found or inactive': 'package_not_found',
  'Package not available for purchase': 'package_not_found',
  'Insufficient wallet balance': 'insufficient_balance',
  'Business account is suspended': 'business_suspended',
  'quantity must be between 1 and 100': 'invalid_input',
  'This package requires a travel date': 'travel_date_required',
  'travelDate must be a valid date': 'invalid_travel_date',
  'No provider adapter available': 'provider_failed',
  'Provider activation failed': 'provider_failed',
  'Provider returned fewer ICCIDs': 'provider_failed',
  'This package is temporarily unavailable': 'package_pricing_unavailable',
  'Quote not found': 'quote_required',
  'Quote has expired': 'quote_expired',
  'Quote is already': 'quote_already_used',
  'No eligible provider found': 'temporarily_unavailable',
  'Provider not found': 'temporarily_unavailable',
  'Provider does not support purchases': 'temporarily_unavailable',
  'A valid purchase quote is required for checkout': 'quote_required',
  'Failed to create order': 'order_creation_failed',
  'Wallet reserve failed': 'purchase_failed',
}

export async function purchaseESIMs(formData: FormData) {
  const session = await getServerSession(authOptions)
  const correlationId = `purchase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  console.log('[SERVER] purchaseESIMs invoked', { correlationId })

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const rawTravelDate = (formData.get('travelDate') as string) || undefined
  const parsedQty = parseInt(formData.get('quantity') as string)
  const pkgId = formData.get('packageId') as string

  console.log(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=ACTION_RECEIVED status=START packageId=${pkgId} quantity=${parsedQty} businessId=${session.user.businessId}`)

  const validatedFields = purchaseESIMSchema.safeParse({
    packageId: pkgId,
    quantity: parsedQty,
    idempotencyKey: formData.get('idempotencyKey') as string,
    travelDate: rawTravelDate,
  })

  if (!validatedFields.success) {
    console.log(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=VALIDATION status=FAILED`)
    redirect('/business/buy-esim?error=invalid_input')
  }

  const { packageId, quantity, travelDate } = validatedFields.data
  const businessId = session.user.businessId!

  const result = await createOrder({
    businessId,
    userId: session.user.id,
    packageId,
    quantity,
    travelDate: travelDate || undefined,
    correlationId,
  })

  if (!result.success) {
    const msg = result.error || 'Purchase failed'
    console.error(`purchaseESIMs failed: business=${businessId} pkg=${packageId} qty=${quantity} error=${msg}`)

    let publicCode = 'purchase_failed'
    for (const [key, value] of Object.entries(ERROR_MAP)) {
      if (msg.startsWith(key)) {
        publicCode = value
        break
      }
    }
    console.log(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=ACTION_RESULT status=FAILED publicCode=${publicCode}`)
    redirect(`/business/buy-esim?error=${publicCode}`)
  }

  revalidatePath('/business/orders')
  revalidatePath('/business/orders/[id]')
  revalidatePath('/business/esims')
  revalidatePath('/business/wallet')
  revalidatePath('/business/dashboard')

  console.log(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=ACTION_RESULT status=SUCCESS orderId=${result.orderId}`)
  redirect(`/business/orders/${result.orderId}`)
}

export async function requestPurchaseQuote(packageId: string, quantity: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') return { success: false, error: 'Not authorized' }

  console.log(`[BUSINESS_QUOTE_TRACE] stage=ACTION_RECEIVED status=START packageId=${packageId} quantity=${quantity}`)

  const retailPkg = await prisma.eSIMPackage.findUnique({
    where: { id: packageId },
    select: { id: true, providerPackageId: true, displayName: true, name: true, isActive: true, hiddenFromCatalog: true, archivedAt: true },
  })
  if (!retailPkg) {
    console.log(`[BUSINESS_QUOTE_TRACE] stage=PROVIDER_PACKAGE_RESOLUTION status=FAILED reason=package_not_found`)
    return { success: false, error: 'Package not found', code: 'package_not_found' }
  }
  if (!retailPkg.isActive || retailPkg.hiddenFromCatalog || retailPkg.archivedAt) {
    console.log(`[BUSINESS_QUOTE_TRACE] stage=PROVIDER_PACKAGE_RESOLUTION status=FAILED reason=package_unavailable`)
    return { success: false, error: 'Package not available', code: 'package_unavailable' }
  }
  if (!retailPkg.providerPackageId) {
    console.log(`[BUSINESS_QUOTE_TRACE] stage=PROVIDER_PACKAGE_RESOLUTION status=FAILED reason=no_provider_package`)
    return { success: false, error: 'Package pricing not configured', code: 'provider_package_missing' }
  }
  console.log(`[BUSINESS_QUOTE_TRACE] stage=PROVIDER_PACKAGE_RESOLUTION status=SUCCESS providerPackagePresent=true`)

  const quoteResult = await createPurchaseQuote({
    businessId: session.user.businessId!,
    providerPackageId: retailPkg.providerPackageId,
    quantity,
  })

  if (!quoteResult.success) {
    const safeError = quoteResult.error || 'Quote creation failed'
    const code = safeError.includes('snapshot') ? 'pricing_snapshot_unavailable'
      : safeError.includes('pricing') || safeError.includes('not available') ? 'package_pricing_unavailable'
      : safeError.includes('selling price') ? 'quote_invalid'
      : 'pricing_unavailable'
    console.log(`[BUSINESS_QUOTE_TRACE] stage=ACTION_RESULT status=FAILED internalCode=${code} error=${safeError.substring(0, 80)}`)
    return { success: false, error: safeError, code }
  }

  console.log(`[BUSINESS_QUOTE_TRACE] stage=ACTION_RESULT status=SUCCESS quoteRef=${quoteResult.quote.reference}`)
  return { success: true, quote: quoteResult.quote }
}
