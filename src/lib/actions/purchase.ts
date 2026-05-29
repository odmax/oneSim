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
  'No provider adapter available': 'provider_failed',
  'Provider activation failed': 'provider_failed',
  'Provider returned fewer ICCIDs': 'provider_failed',
}

export async function purchaseESIMs(formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const validatedFields = purchaseESIMSchema.safeParse({
    packageId: formData.get('packageId'),
    quantity: parseInt(formData.get('quantity') as string),
  })

  if (!validatedFields.success) {
    redirect('/business/buy-esim?error=invalid_input')
  }

  const { packageId, quantity } = validatedFields.data
  const businessId = session.user.businessId!

  const result = await createOrder({
    businessId,
    userId: session.user.id,
    packageId,
    quantity,
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
  revalidatePath('/business/esims')
  revalidatePath('/business/wallet')
  revalidatePath('/business/dashboard')

  redirect('/business/orders')
}
