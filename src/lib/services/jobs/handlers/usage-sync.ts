import { prisma } from '@/lib/prisma'

export async function syncUsage(businessId?: string, esimId?: string) {
  // Placeholder: future implementation will call provider APIs to fetch usage data
  // The actual sync will query each provider via its connector for data usage records
  // and upsert them into the UsageRecord table, then trigger esim.usage.updated webhooks

  if (esimId) {
    const esim = await prisma.eSIM.findUnique({ where: { id: esimId } })
    if (!esim) return { completed: false, error: 'eSIM not found' }
    // Future: call provider API to get usage for this eSIM
    return { completed: true }
  }

  if (businessId) {
    const esims = await prisma.eSIM.findMany({
      where: {
        purchase: { businessId },
        status: 'ACTIVE',
      },
      take: 50,
    })
    // Future: batch sync usage for all active eSIMs of this business
    return { completed: true, details: `Found ${esims.length} active eSIMs to sync` }
  }

  // Sync all businesses
  const businesses = await prisma.business.findMany({
    where: { status: 'APPROVED' },
    select: { id: true },
  })

  return { completed: true, details: `Found ${businesses.length} businesses to sync usage for` }
}
