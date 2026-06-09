import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncESIMStatus } from '@/lib/services/esims/sync-esim-status'

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const shareToken = await prisma.eSIMShareToken.findUnique({
      where: { token: params.token },
      select: { id: true, expiresAt: true, usedAt: true, esimId: true },
    })

    if (!shareToken || shareToken.expiresAt < new Date()) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Install link expired or invalid' } }, { status: 404 })
    }

    const result = await syncESIMStatus(shareToken.esimId)

    if (!result.success) {
      return NextResponse.json({ success: false, error: { code: 'SYNC_FAILED', message: result.error || 'Status refresh failed' } }, { status: 500 })
    }

    const esim = await prisma.eSIM.findUnique({
      where: { id: shareToken.esimId },
      select: { status: true, activationDetectedAt: true, dataUsedMB: true, dataRemainingMB: true, dataTotalMB: true, activatedAt: true, lastUsageAt: true },
    })

    return NextResponse.json({
      success: true,
      newStatus: esim?.status,
      statusChanged: result.statusChanged,
      activated: result.activated,
      activationDetectedAt: esim?.activationDetectedAt?.toISOString() || null,
      dataUsedMB: esim?.dataUsedMB,
      dataRemainingMB: esim?.dataRemainingMB,
      dataTotalMB: esim?.dataTotalMB,
    })
  } catch (error: any) {
    console.error('Install refresh-status error:', error)
    return NextResponse.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }, { status: 500 })
  }
}