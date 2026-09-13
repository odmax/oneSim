import { prisma } from '@/lib/prisma'
import { getPlatformBaseCurrency } from './currency-config'
import { validateRate } from './exchange-rate-service'
import { acquireSystemJobLease } from '@/lib/services/jobs/system-job-lock'

const LOCK_TTL_MINUTES = 15

export async function refreshExchangeRates(): Promise<{
  ratesRefreshed: number; ratesStale: number; affectedPackages: number
}> {
  // Acquire a single-statement atomic lease. A concurrent replica holding an
  // unexpired 'exchange-rate-refresh' lease is skipped cleanly (no overwrite);
  // an expired lease (crash) is immediately re-acquirable.
  const now = new Date()
  const locked = await acquireSystemJobLease({
    jobName: 'exchange-rate-refresh',
    owner: `refresh-${process.pid}-${Date.now()}`,
    ttlMs: LOCK_TTL_MINUTES * 60 * 1000,
  }).catch(() => false)
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
