export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const providers = await prisma.provider.findMany({
      select: { id: true, name: true, code: true, status: true, certificationStatus: true, lastSuccessfulConnection: true, lastFailedConnection: true, errorCount: true, lastError: true, supportsESIM: true },
      orderBy: { name: 'asc' },
    })

    const total = providers.length
    const operational = providers.filter(p => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)).length
    const degraded = providers.filter(p => p.status === 'DEGRADED').length
    const offline = providers.filter(p => ['INACTIVE', 'MAINTENANCE'].includes(p.status)).length
    const archived = providers.filter(p => p.status === 'ARCHIVED').length
    const hasErrors = providers.filter(p => (p.errorCount || 0) > 0).length
    const certified = providers.filter(p => p.certificationStatus === 'CERTIFIED').length

    return NextResponse.json({
      success: true,
      status: offline > 0 ? 'degraded' : 'healthy',
      summary: { total, operational, degraded, offline, archived, hasErrors, certified },
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        code: p.code,
        status: p.status,
        certification: p.certificationStatus || 'CONFIGURING',
        hasRecentError: (p.errorCount || 0) > 0,
        lastConnection: p.lastSuccessfulConnection?.toISOString() || null,
        lastError: p.lastError,
        lastErrorDate: p.lastFailedConnection?.toISOString() || null,
      })),
      timestamp: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, status: 'error', error: e.message }, { status: 500 })
  }
}
