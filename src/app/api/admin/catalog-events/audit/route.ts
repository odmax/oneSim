import { NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { catalogPipelineAudit } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const audit = await catalogPipelineAudit()
  return NextResponse.json(audit)
}
