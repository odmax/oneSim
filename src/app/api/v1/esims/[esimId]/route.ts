export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { apiError } from '@/lib/api/error-contract'
import { stripPackageProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { getActivationInstructions } from '@/lib/esim/activation-instructions'
import { getPackageDisplayName, getPackageDataGB, PurchaseSnapshot } from '@/lib/packages/snapshot-utils'

export async function GET(
  request: NextRequest,
  { params }: { params: { esimId: string } },
) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit, requestId } = await authenticateAndCheck(request, startTime)
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
    return apiError('NOT_FOUND', 'eSIM not found', 404, undefined, requestId)
  }

  if (esim.purchase.businessId !== businessId) {
    return apiError('FORBIDDEN', 'eSIM does not belong to this business', 403, undefined, requestId)
  }

  const safeEsim = stripEsimProviderFields(esim)
  const dataUsedMB = esim.dataUsedMB || esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
  const instructions = getActivationInstructions(!!esim.qrCodeUrl)

  const snap = (esim.packageSnapshot || esim.purchase.packageSnapshot) as PurchaseSnapshot | null
  const packageInfo = snap ? {
    id: snap.packageId || esim.purchase.package.id,
    displayName: snap.displayName || safeEsim.packageName || esim.purchase.package.displayName || esim.purchase.package.name,
    dataGB: snap.dataGB || esim.packageDataGB || esim.purchase.packageDataGB || esim.purchase.package.dataGB,
    validityDays: snap.validityDays || esim.packageValidityDays || esim.purchase.packageValidityDays || esim.purchase.package.validityDays,
    unitCost: snap.priceUSD || parseFloat(esim.purchase.package.priceUSD.toString()),
    currency: snap.currency || esim.purchase.package.currency || 'USD',
  } : {
    id: esim.purchase.package.id,
    displayName: safeEsim.packageName || esim.purchase.package.displayName || esim.purchase.package.name,
    dataGB: esim.packageDataGB || esim.purchase.packageDataGB || esim.purchase.package.dataGB,
    validityDays: esim.packageValidityDays || esim.purchase.packageValidityDays || esim.purchase.package.validityDays,
    unitCost: parseFloat(esim.purchase.package.priceUSD.toString()),
    currency: esim.purchase.package.currency || 'USD',
  }

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
      package: packageInfo,
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