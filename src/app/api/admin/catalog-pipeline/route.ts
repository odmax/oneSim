import { NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied
  return NextResponse.json({ message: 'Use /api/admin/catalog-pipeline/runs or /api/admin/catalog-pipeline/summary' })
}
