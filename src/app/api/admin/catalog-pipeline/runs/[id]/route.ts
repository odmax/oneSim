import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { getPipelineRunDetail } from '@/lib/catalog-pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  try {
    const run = await getPipelineRunDetail(params.id)
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    }
    return NextResponse.json(run)
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to fetch run' }, { status: 500 })
  }
}
