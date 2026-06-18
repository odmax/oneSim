import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { exportImportedPlansCsv } from '@/lib/actions/imported-plans'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return new Response('Unauthorized', { status: 401 })
  }

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
