import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { getPipelineSummary, runCatalogHealthDiagnostics } from '@/lib/catalog-pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const { searchParams } = new URL(request.url)
  const providerId = searchParams.get('providerId') || undefined

  try {
    const summary = await getPipelineSummary(providerId)
    const health = await runCatalogHealthDiagnostics(providerId)

    return NextResponse.json({
      ...summary,
      currentHealth: health,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to fetch summary' }, { status: 500 })
  }
}
