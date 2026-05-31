import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { getActivationInstructions } from '@/lib/esim/activation-instructions'

export async function GET(
  request: NextRequest,
  { params }: { params: { esimId: string } },
) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.esimId },
    include: {
      purchase: {
        include: { package: true },
      },
      usageRecords: {
        orderBy: { timestamp: 'desc' },
      },
    },
  })

  if (!esim) {
    return respond(request, { success: false, error: 'eSIM not found' }, 404, startTime, businessId, {
      apiKeyId,
      rateLimit,
      errorMessage: 'eSIM not found',
    })
  }

  if (esim.purchase.businessId !== businessId) {
    return respond(request, { success: false, error: 'Forbidden' }, 403, startTime, businessId, {
      apiKeyId,
      rateLimit,
      errorMessage: 'eSIM does not belong to this business',
    })
  }

  const safeEsim = stripEsimProviderFields(esim)
  const safePackage = stripPackageProviderFields(esim.purchase.package)

  const dataUsedMB = esim.dataUsedMB || esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
  const instructions = getActivationInstructions(!!esim.qrCodeUrl)

  return respond(request, {
    success: true,
    esim: {
      id: safeEsim.id,
      iccid: safeEsim.iccid,
      imsi: safeEsim.imsi || undefined,
      status: esim.status,
      statusLabel: esim.status === 'PENDING_ACTIVATION' ? 'Ready to install' :
                    esim.status === 'ACTIVE' ? 'Activated on device' :
                    esim.status === 'EXPIRED' ? 'Expired' :
                    esim.status === 'SUSPENDED' ? 'Suspended' :
                    esim.status === 'FAILED' ? 'Provisioning failed' : esim.status,
      qrCodeUrl: safeEsim.qrCodeUrl,
      activationCode: safeEsim.activationCode || undefined,
      activatedAt: esim.activatedAt,
      activationDetectedAt: esim.activationDetectedAt,
      lastUsageAt: esim.lastUsageAt,
      expiresAt: esim.expiresAt,
      dataUsedMB,
      dataRemainingMB: esim.dataRemainingMB,
      dataTotalMB: esim.dataTotalMB,
      package: safePackage,
      usageRecords: esim.usageRecords,
      activationInstructions: instructions,
      sharedAt: esim.sharedAt,
      sharedToEmail: esim.sharedToEmail,
      lastStatusSyncAt: esim.lastStatusSyncAt,
    },
  }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}