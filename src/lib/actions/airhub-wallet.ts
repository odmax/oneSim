'use server'

import { prisma } from '@/lib/prisma'

/**
 * Fetch Airhub wallet balance. Preserves last valid balance on failure.
 *
 * Contract: GET /api/ESIM/get_wallet_invidual?partnercode=12345
 *           Header: Authorization: Bearer {token}
 */
export async function fetchAirhubWallet(providerId: string, syncSource: string = 'MANUAL', actorId?: string) {
  const { AirHubConnector } = await import('@/lib/providers/connectors/airhub-connector')
  const startedAt = new Date()

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, code: true, name: true, config: true, apiToken: true, tokenPlacement: true },
  })
  if (!provider || provider.code !== 'AIRHUB' || !(provider.config as any)?.partnerCode) {
    return { success: false, error: 'Not a configured AirHub provider' }
  }

  const previous = await prisma.providerWallet.findUnique({ where: { providerId } })

  const connector = new AirHubConnector(providerId)
  await connector.authenticate({ username: (provider.config as any)?.username || '', password: (provider.config as any)?.password || '' })
  const result = await connector.getWalletBalance()

  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()

  const auditEntry = {
    providerId,
    syncSource,
    actorId: actorId || null,
    startedAt, finishedAt, durationMs,
    success: result.success,
    statusCode: result.error?.code || 'OK',
    previousBalance: previous?.balance ?? null,
    newBalance: result.success ? result.data!.balance : null,
    currency: result.success ? result.data!.currency : previous?.currency ?? 'USD',
  }

  if (!result.success) {
    // Preserve last valid balance — only update status/error metadata
    if (previous) {
      await prisma.providerWallet.update({
        where: { providerId },
        data: { syncStatus: mapErrorCode(result.error?.code), lastError: sanitizeError(result.error?.message), lastSyncedAt: previous.lastSyncedAt },
      })
    } else {
      await prisma.providerWallet.upsert({
        where: { providerId },
        create: { providerId, balance: 0, syncStatus: mapErrorCode(result.error?.code), lastError: sanitizeError(result.error?.message), lastSyncedAt: null },
        update: { syncStatus: mapErrorCode(result.error?.code), lastError: sanitizeError(result.error?.message) },
      })
    }

    await recordSyncAudit({ ...auditEntry, errorMessage: sanitizeError(result.error?.message) })
    return { success: false, error: result.error?.message || 'Wallet fetch failed' }
  }

  const { balance, currency, rawAvailable } = result.data!

  // Detect low-balance threshold crossing
  const threshold = previous?.lowBalanceThreshold
  if (threshold != null && threshold > 0) {
    const wasAbove = previous?.balance != null && previous.balance > threshold
    const nowBelow = balance < threshold
    if (wasAbove && nowBelow) {
      await createLowBalanceAlert(providerId, provider.name, balance, threshold, currency)
    } else if (previous?.syncStatus === 'LOW_BALANCE' && balance > threshold) {
      await createRecoveryAlert(providerId, provider.name, balance, threshold, currency)
    }
  }

  const wallet = await prisma.providerWallet.upsert({
    where: { providerId },
    create: {
      providerId, balance, currency,
      available: JSON.stringify(rawAvailable ?? null),
      syncStatus: threshold && balance < threshold ? 'LOW_BALANCE' : 'OK',
      lastSyncedAt: finishedAt, lastError: null,
    },
    update: {
      balance, currency,
      available: JSON.stringify(rawAvailable ?? null),
      syncStatus: threshold && balance < threshold ? 'LOW_BALANCE' : 'OK',
      lastSyncedAt: finishedAt, lastError: null,
    },
  })

  await prisma.providerWalletSnapshot.create({
    data: { walletId: wallet.id, balance, currency, available: JSON.stringify(rawAvailable ?? null) },
  })

  await recordSyncAudit(auditEntry)
  return { success: true, data: { balance, currency, lastSyncedAt: wallet.lastSyncedAt?.toISOString() } }
}

function mapErrorCode(code?: string): string {
  if (code === 'TIMEOUT') return 'TIMEOUT'
  if (code === 'UNAUTHORIZED' || code === 'NO_TOKEN') return 'UNAUTHORIZED'
  if (code === 'DNS_ERROR' || code === 'NETWORK_ERROR') return 'ERROR'
  if (code === 'MALFORMED_RESPONSE') return 'ERROR'
  return 'ERROR'
}

function sanitizeError(msg?: string): string | null {
  if (!msg) return null
  return msg.replace(/(Bearer\s+[\w.\-]+)/gi, '***').substring(0, 500)
}

async function recordSyncAudit(entry: {
  providerId: string; syncSource: string; actorId?: string | null;
  startedAt: Date; finishedAt: Date; durationMs: number;
  success: boolean; statusCode: string;
  previousBalance: number | null; newBalance: number | null; currency: string;
  errorMessage?: string | null;
}) {
  await prisma.auditLog.create({
    data: {
      userId: entry.actorId || 'system',
      action: `WALLET_SYNC_${entry.syncSource}`,
      entity: 'ProviderWallet',
      entityId: entry.providerId,
      details: JSON.stringify({
        success: entry.success,
        statusCode: entry.statusCode,
        previousBalance: entry.previousBalance,
        newBalance: entry.newBalance,
        currency: entry.currency,
        durationMs: entry.durationMs,
        error: entry.errorMessage || null,
      }),
    },
  }).catch(() => {})
}

async function createLowBalanceAlert(providerId: string, providerName: string, balance: number, threshold: number, currency: string) {
  // Idempotency: skip if alert already created since last sync
  const recentAlert = await prisma.auditLog.findFirst({
    where: { entity: 'ProviderWallet', entityId: providerId, action: 'WALLET_LOW_BALANCE_ALERT', createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  })
  if (recentAlert) return

  await prisma.auditLog.create({
    data: {
      userId: 'system',
      action: 'WALLET_LOW_BALANCE_ALERT',
      entity: 'ProviderWallet',
      entityId: providerId,
      details: JSON.stringify({ providerName, balance, threshold, currency, message: `Balance $${balance} ${currency} is below threshold $${threshold}` }),
    },
  }).catch(() => {})
}

async function createRecoveryAlert(providerId: string, providerName: string, balance: number, threshold: number, currency: string) {
  await prisma.auditLog.create({
    data: {
      userId: 'system',
      action: 'WALLET_RECOVERY_ALERT',
      entity: 'ProviderWallet',
      entityId: providerId,
      details: JSON.stringify({ providerName, balance, threshold, currency, message: `Balance recovered: $${balance} ${currency} is now above threshold $${threshold}` }),
    },
  }).catch(() => {})
}
