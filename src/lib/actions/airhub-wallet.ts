'use server'

import { prisma } from '@/lib/prisma'

/**
 * Generic Provider Wallet — AirHub, Choice, and any provider with getBalance().
 * Preserves last valid balance on failure.
 */
export async function fetchAirhubWallet(providerId: string, syncSource: string = 'MANUAL', actorId?: string) {
  const startedAt = new Date()

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, code: true, name: true, config: true, apiToken: true, tokenPlacement: true },
  })
  if (!provider) return { success: false, error: 'Provider not found' }

  const previous = await prisma.providerWallet.findUnique({ where: { providerId } })

  let balance: number | null = null
  let currency: string | null = null
  let connectSuccess = false
  let errorMessage: string | null = null
  const finishedAt = new Date()

  // Route to the correct connector
  try {
    if (provider.code === 'AIRHUB') {
      const { AirHubConnector } = await import('@/lib/providers/connectors/airhub-connector')
      const connector = new AirHubConnector(providerId)
      await connector.authenticate({ username: (provider.config as any)?.username || '', password: (provider.config as any)?.password || '' })
      const result = await connector.getWalletBalance()
      if (result.success && result.data) {
        balance = result.data.balance
        currency = result.data.currency
        connectSuccess = true
      } else {
        errorMessage = result.error?.message || 'Wallet fetch failed'
      }
    } else {
      // Generic connector: Choice, Telna, etc.
      const { getAdapterForProvider } = await import('@/lib/providers/adapter-manager')
      const adapter = await getAdapterForProvider(providerId)
      if (typeof (adapter as any).getBalance === 'function') {
        const result = await (adapter as any).getBalance()
        if (result.success && result.data) {
          balance = result.data.balance
          currency = result.data.currency
          connectSuccess = true
        } else {
          errorMessage = result.error?.message || 'Balance fetch failed'
        }
      } else {
        return { success: false, error: 'Provider does not support balance' }
      }
    }
  } catch (e: any) {
    errorMessage = e.message?.substring(0, 200) || 'Unknown error'
  }

  const auditEntry = {
    providerId, syncSource, actorId: actorId || null,
    startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
    success: connectSuccess,
    statusCode: connectSuccess ? 'OK' : 'ERROR',
    previousBalance: previous?.balance ?? null,
    newBalance: balance,
    currency: currency || previous?.currency || 'USD',
  }

  if (!connectSuccess) {
    if (previous) {
      await prisma.providerWallet.update({
        where: { providerId },
        data: { syncStatus: 'ERROR', lastError: errorMessage || 'Fetch failed' },
      }).catch(() => {})
    } else {
      await prisma.providerWallet.upsert({
        where: { providerId },
        create: { providerId, balance: 0, syncStatus: 'ERROR', lastError: errorMessage },
        update: { syncStatus: 'ERROR', lastError: errorMessage },
      }).catch(() => {})
    }
    return { success: false, error: errorMessage || 'Wallet fetch failed' }
  }

  const threshold = previous?.lowBalanceThreshold

  if (threshold != null && threshold > 0 && balance != null) {
    const wasAbove = previous?.balance != null && previous.balance > threshold
    const nowBelow = balance < threshold
    if (wasAbove && nowBelow) {
      await prisma.auditLog.create({
        data: { userId: actorId || 'system', action: 'WALLET_LOW_BALANCE_ALERT', entity: 'ProviderWallet', entityId: providerId,
          details: JSON.stringify({ providerName: provider.name, balance, threshold, currency, message: `Balance $${balance} is below threshold $${threshold}` }),
        },
      }).catch(() => {})
    }
  }

  const wallet = await prisma.providerWallet.upsert({
    where: { providerId },
    create: { providerId, balance: balance!, currency: currency!, syncStatus: 'OK', lastSyncedAt: finishedAt, lastError: null },
    update: { balance: balance!, currency: currency!, syncStatus: 'OK', lastSyncedAt: finishedAt, lastError: null },
  }).catch(() => null)

  await prisma.providerWalletSnapshot.create({
    data: { walletId: wallet?.id || 'unknown', balance: balance!, currency: currency! },
  }).catch(() => {})

  await prisma.auditLog.create({
    data: { userId: actorId || 'system', action: `WALLET_SYNC_${syncSource}`, entity: 'ProviderWallet', entityId: providerId,
      details: JSON.stringify({ ...auditEntry, error: errorMessage }),
    },
  }).catch(() => {})

  return { success: true, data: { balance: balance!, currency: currency!, lastSyncedAt: finishedAt.toISOString() } }
}
