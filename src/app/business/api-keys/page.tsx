import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import ApiKeysClient from './api-keys-client'

export default async function ApiKeysPage() {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const businessUser = await prisma.businessUser.findFirst({
    where: {
      userId: session.user.id,
      businessId: session.user.businessId!,
    },
  })

  const isAdmin = businessUser?.role === 'ADMIN'

  const keys = await prisma.businessApiKey.findMany({
    where: { businessId: session.user.businessId! },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
  })

  return (
    <div className="space-y-6">
      <ApiKeysClient keys={keys.map(k => ({
        ...k,
        lastUsedAt: k.lastUsedAt?.toISOString() || null,
        createdAt: k.createdAt.toISOString(),
      }))} isAdmin={isAdmin} />
    </div>
  )
}
