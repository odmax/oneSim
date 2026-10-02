export const dynamic = 'force-dynamic';

import { exportPricingCsv } from '@/lib/actions/pricing-csv'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_PRICING)
  if (!allowed) return denied

  try {
    const csv = await exportPricingCsv()
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pricing-export-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (e: any) {
    return new Response(e.message || 'Export failed', { status: 500 })
  }
}
