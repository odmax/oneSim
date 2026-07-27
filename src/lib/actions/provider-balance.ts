'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import type { ProviderBalanceResult } from '@/lib/services/providers/provider-balance'

export async function getProviderBalanceAction(providerId: string, forceRefresh?: boolean): Promise<ProviderBalanceResult> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, supported: false, providerId, providerCode: '', balance: null, currency: null, fetchedAt: new Date(), source: 'UNSUPPORTED', error: 'Unauthorized' }
  }

  if (!providerId || typeof providerId !== 'string') {
    return { success: false, supported: false, providerId: '', providerCode: '', balance: null, currency: null, fetchedAt: new Date(), source: 'UNSUPPORTED', error: 'Invalid provider ID' }
  }

  return getProviderBalance(providerId, { forceRefresh })
}
