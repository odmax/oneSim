import { prisma } from '@/lib/prisma'
import { notFound } from 'next/navigation'
import InstallClient from './InstallClient'

export default async function InstallPage({ params }: { params: { token: string } }) {
  const shareToken = await prisma.eSIMShareToken.findUnique({
    where: { token: params.token },
    include: {
      esim: {
        include: {
          purchase: {
            include: { package: true },
          },
          usageRecords: { orderBy: { timestamp: 'desc' }, take: 1 },
        },
      },
    },
  })

  if (!shareToken || shareToken.expiresAt < new Date() || shareToken.usedAt) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="text-6xl">📱</div>
          <h1 className="text-2xl font-bold text-gray-900">Install Link Expired or Invalid</h1>
          <p className="text-gray-500">This installation link is no longer valid. Please contact the business that provided your eSIM to request a new one.</p>
        </div>
      </div>
    )
  }

  const esim = shareToken.esim
  const pkg = esim.purchase.package
  const latestUsage = esim.usageRecords[0]

  // Build safe display data (no provider internals)
  const display = {
    id: esim.id,
    iccid: esim.iccid,
    imsi: esim.imsi || null,
    status: esim.status,
    statusLabel: esim.status === 'PENDING_ACTIVATION' ? 'Ready to install' :
                  esim.status === 'ACTIVE' ? 'Active' :
                 esim.status === 'EXPIRED' ? 'Expired' :
                 esim.status === 'SUSPENDED' ? 'Suspended' :
                 esim.status === 'FAILED' ? 'Provisioning failed' : esim.status,
    activationCode: esim.activationCode || null,
    qrCodeUrl: esim.qrCodeUrl || null,
    expiresAt: esim.expiresAt?.toISOString() || null,
    packageName: esim.packageName || pkg.displayName || pkg.name,
    dataGB: esim.packageDataGB || pkg.dataGB,
    validityDays: esim.packageValidityDays || pkg.validityDays,
    dataUsedMB: esim.dataUsedMB || latestUsage?.dataUsedMB || 0,
    dataTotalMB: esim.dataTotalMB || latestUsage?.dataTotalMB || (pkg.dataGB * 1024),
    dataRemainingMB: esim.dataRemainingMB ?? latestUsage?.dataRemainingMB ?? null,
    activationDetectedAt: esim.activationDetectedAt?.toISOString() || null,
    lastUsageAt: esim.lastUsageAt?.toISOString() || null,
  }

  return <InstallClient esim={display} token={params.token} />
}