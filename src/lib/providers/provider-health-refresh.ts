import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'

export async function refreshProviderHealth(providerId: string, paths?: string[]) {
  const toRevalidate = paths || [
    `/admin/providers/${providerId}`,
    '/admin/providers',
    '/admin/provider-catalog',
  ]
  for (const p of toRevalidate) {
    revalidatePath(p)
  }
}

export interface ProviderHealthData {
  id: string
  code: string
  name: string
  status: string
  adapterStrategy: string | null
  apiToken: string | null
  lastSuccessfulConnection: Date | null
  lastFailedConnection: Date | null
  errorCount: number | null
  lastError: string | null
  lastSyncAt: Date | null
  lastSyncCount: number | null
  lastSyncResult: string | null
  config: any
  packageCount: number
}

export async function getProviderHealthData(providerId: string): Promise<ProviderHealthData | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      adapterStrategy: true,
      apiToken: true,
      lastSuccessfulConnection: true,
      lastFailedConnection: true,
      errorCount: true,
      lastError: true,
      lastSyncAt: true,
      lastSyncCount: true,
      lastSyncResult: true,
      config: true,
    },
  })
  if (!provider) return null

  const packageCount = await prisma.providerPackage.count({
    where: { providerId },
  })

  return { ...provider, packageCount }
}
