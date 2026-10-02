export const dynamic = 'force-dynamic';

import { exportImportedPlansCsv } from '@/lib/actions/imported-plans'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_PROVIDERS)
  if (!allowed) return denied

  try {
    const csv = await exportImportedPlansCsv()
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="imported-plans-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (e: any) {
    return new Response(e.message || 'Export failed', { status: 500 })
  }
}
