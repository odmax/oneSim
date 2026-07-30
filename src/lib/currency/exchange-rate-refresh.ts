import { prisma } from '@/lib/prisma'
import { getPlatformBaseCurrency } from './currency-config'
import { validateRate } from './exchange-rate-service'

const LOCK_TTL_MINUTES = 15
const LOCK_OWNER = `refresh-${process.pid}-${Date.now()}`

export async function refreshExchangeRates(): Promise<{
  ratesRefreshed: number; ratesStale: number; affectedPackages: number
}> {
  // Acquire distributed lock
  const now = new Date()
  const lockUntil = new Date(now.getTime() + LOCK_TTL_MINUTES * 60 * 1000)

  const locked = await prisma.systemJobLock.upsert({
    where: { jobName: 'exchange-rate-refresh' },
    create: { jobName: 'exchange-rate-refresh', lockedAt: now, lockedUntil: lockUntil, owner: LOCK_OWNER },
    update: { lockedAt: now, lockedUntil: lockUntil, owner: LOCK_OWNER },
  }).catch(() => null)
  if (!locked) return { ratesRefreshed: 0, ratesStale: 0, affectedPackages: 0 }

  // Mark expired rates as stale
  const staleResult = await prisma.exchangeRate.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'STALE' },
  })

  const base = getPlatformBaseCurrency()
  const affectedPackages = await prisma.providerPackage.count({
    where: { costStatus: 'VALID', isAvailable: true, pricingStatus: { not: 'DISABLED' } },
  })

  return { ratesRefreshed: 0, ratesStale: staleResult.count, affectedPackages }
}
