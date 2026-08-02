'use server'

import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { purchaseESIMSchema } from '@/lib/validators/business'
import { createOrder } from '@/lib/services/orders/create-order'

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
}

export async function purchaseESIMs(formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const rawTravelDate = (formData.get('travelDate') as string) || undefined

  const validatedFields = purchaseESIMSchema.safeParse({
    packageId: formData.get('packageId'),
    quantity: parseInt(formData.get('quantity') as string),
    idempotencyKey: formData.get('idempotencyKey') as string,
    travelDate: rawTravelDate,
  })

  if (!validatedFields.success) {
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
  })

  if (!result.success) {
    const msg = result.error || 'Purchase failed'
    console.error(`purchaseESIMs failed: business=${businessId} pkg=${packageId} qty=${quantity} error=${msg}`)

    for (const [key, value] of Object.entries(ERROR_MAP)) {
      if (msg.startsWith(key)) {
        redirect(`/business/buy-esim?error=${value}`)
      }
    }
    redirect(`/business/buy-esim?error=purchase_failed`)
  }

  revalidatePath('/business/orders')
  revalidatePath('/business/orders/[id]')
  revalidatePath('/business/esims')
  revalidatePath('/business/wallet')
  revalidatePath('/business/dashboard')

  // Redirect to order detail page on success
  redirect(`/business/orders/${result.orderId}`)
}
