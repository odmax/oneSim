import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { stripPackageProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { getActivationInstructions } from '@/lib/esim/activation-instructions'

export async function GET(
  request: NextRequest,
  { params }: { params: { iccid: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const iccid = params.iccid

  const esim = await prisma.eSIM.findUnique({
    where: { iccid },
    include: {
      purchase: {
        include: { package: true },
      },
      usageRecords: true,
    },
  })

  if (!esim) {
    return NextResponse.json({ error: 'eSIM not found' }, { status: 404 })
  }

  if (session.user.role === 'BUSINESS_USER') {
    if (esim.purchase.businessId !== session.user.businessId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  } else if (session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const safeEsim = stripEsimProviderFields(esim)
  const safePackage = stripPackageProviderFields(esim.purchase.package)
  const instructions = getActivationInstructions(!!esim.qrCodeUrl)

  return NextResponse.json({
    iccid: safeEsim.iccid,
    status: esim.status,
    package: safePackage,
    qrCodeUrl: safeEsim.qrCodeUrl,
    activationCode: safeEsim.activationCode || undefined,
    imsi: safeEsim.imsi || undefined,
    expiresAt: safeEsim.expiresAt,
    usage: esim.usageRecords,
    dataUsedMB: esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0),
    activationInstructions: instructions,
  })
}
