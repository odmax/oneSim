import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { getPipelineRuns } from '@/lib/catalog-pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const { searchParams } = new URL(request.url)

  try {
    const result = await getPipelineRuns({
      providerId: searchParams.get('providerId') || undefined,
      providerCode: searchParams.get('providerCode') || undefined,
      status: searchParams.get('status') || undefined,
      trigger: searchParams.get('trigger') || undefined,
      fromDate: searchParams.get('fromDate') || undefined,
      toDate: searchParams.get('toDate') || undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : 0,
    })

    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to fetch pipeline runs' }, { status: 500 })
  }
}
