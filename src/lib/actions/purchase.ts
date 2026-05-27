'use server'

import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { purchaseESIMSchema } from '@/lib/validators/business'
import { createOrder } from '@/lib/services/orders/create-order'

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
    const errorMap: Record<string, string> = {
      'Package not found or inactive': 'package_not_found',
      'Package not available for purchase': 'package_not_found',
      'Insufficient wallet balance': 'insufficient_balance',
      'Business account is suspended': 'purchase_failed',
      'quantity must be between 1 and 100': 'invalid_input',
    }
    const errorParam = errorMap[result.error!] || 'purchase_failed'
    redirect(`/business/buy-esim?error=${errorParam}`)
  }

  revalidatePath('/business/orders')
  revalidatePath('/business/esims')
  revalidatePath('/business/wallet')
  revalidatePath('/business/dashboard')

  redirect('/business/orders')
}
