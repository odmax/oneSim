import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import DevelopersClient from './developers-client'

export default async function DevelopersPage() {
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

  const packages = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    orderBy: { priceUSD: 'asc' },
    select: {
      id: true,
      name: true,
      displayName: true,
      dataGB: true,
      validityDays: true,
      priceUSD: true,
      description: true,
      customerDescription: true,
      sku: true,
      packageCode: true,
    },
  })

  const apiKeys = await prisma.businessApiKey.findMany({
    where: {
      businessId: session.user.businessId!,
      status: 'ACTIVE',
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
    },
  })

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">API Guide</h2>
          <p className="text-gray-600">Learn how to order eSIMs programmatically — step by step</p>
        </div>
        <a
          href="/api/export/developer-docs-pdf"
          className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Download API Docs PDF
        </a>
      </div>

      <DevelopersClient
        packages={packages.map(p => ({
          ...p,
          priceUSD: p.priceUSD.toString(),
          displayName: p.displayName,
          customerDescription: p.customerDescription,
          sku: p.sku,
          packageCode: p.packageCode,
        }))}
        apiKeys={apiKeys}
        isAdmin={isAdmin}
        baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://onesim.africa'}
      />
    </div>
  )
}
