'use server'

import { prisma } from '@/lib/prisma'

export async function fetchAirhubWallet(providerId: string) {
  // Dynamic import to avoid module-level Prisma binding conflicts in tests
  const { AirHubConnector } = await import('@/lib/providers/connectors/airhub-connector')

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, code: true, name: true, config: true, apiToken: true, tokenPlacement: true },
  })
  if (!provider || provider.code !== 'AIRHUB') return { success: false, error: 'Not an AirHub provider' }

  const connector = new AirHubConnector(providerId)
  await connector.authenticate({ username: (provider.config as any)?.username || '', password: (provider.config as any)?.password || '' })
  const result = await connector.getWalletBalance()

  if (!result.success) {
    await prisma.providerWallet.upsert({
      where: { providerId },
      create: { providerId, balance: 0, syncStatus: mapErrorCode(result.error?.code), lastError: result.error?.message, lastSyncedAt: new Date() },
      update: { syncStatus: mapErrorCode(result.error?.code), lastError: result.error?.message, lastSyncedAt: new Date() },
    })
    return { success: false, error: result.error?.message || 'Wallet fetch failed', code: result.error?.code }
  }

  const { balance, currency, rawAvailable } = result.data!

  const wallet = await prisma.providerWallet.upsert({
    where: { providerId },
    create: { providerId, balance, currency, available: JSON.stringify(rawAvailable ?? null), syncStatus: 'OK', lastSyncedAt: new Date(), lastError: null },
    update: { balance, currency, available: JSON.stringify(rawAvailable ?? null), syncStatus: 'OK', lastSyncedAt: new Date(), lastError: null },
  })

  // Snapshot
  await prisma.providerWalletSnapshot.create({
    data: { walletId: wallet.id, balance, currency, available: JSON.stringify(rawAvailable ?? null) },
  })

  return { success: true, data: { balance, currency, lastSyncedAt: wallet.lastSyncedAt?.toISOString() } }
}

function mapErrorCode(code?: string): string {
  if (code === 'TIMEOUT') return 'TIMEOUT'
  if (code === 'UNAUTHORIZED' || code === 'NO_TOKEN') return 'UNAUTHORIZED'
  if (code === 'DNS_ERROR' || code === 'NETWORK_ERROR') return 'ERROR'
  return 'ERROR'
}
