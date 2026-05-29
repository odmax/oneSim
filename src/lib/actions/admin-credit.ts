'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { allocateBusinessCredit } from '@/lib/services/wallet/credit-allocation'
import crypto from 'crypto'
import { revalidatePath } from 'next/cache'

export async function adminAllocateCredit(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const businessId = formData.get('businessId') as string
  const amountStr = formData.get('amount') as string
  const currency = (formData.get('currency') as string) || 'USD'
  const reference = formData.get('reference') as string
  const note = formData.get('note') as string

  if (!businessId) redirect('/admin/credit-allocations/new?error=Business+required')
  if (!amountStr || isNaN(parseFloat(amountStr)) || parseFloat(amountStr) <= 0) {
    redirect('/admin/credit-allocations/new?error=Amount+must+be+greater+than+0')
  }
  if (!reference) redirect('/admin/credit-allocations/new?error=Reference+required')

  const result = await allocateBusinessCredit({
    businessId,
    amount: parseFloat(amountStr),
    currency,
    reference,
    source: 'ADMIN',
    note: note || undefined,
    allocatedById: session.user.id,
  })

  if (!result.success) {
    redirect(`/admin/credit-allocations/new?error=${encodeURIComponent(result.error || 'Allocation failed')}`)
  }

  revalidatePath('/admin/wallet-topups')
  redirect('/admin/wallet-topups?success=Credit+allocated')
}
