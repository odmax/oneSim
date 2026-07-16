import { NextResponse } from 'next/server'
import { runProviderMaintenance, getCatalogSyncDueProviders } from '@/lib/services/providers/provider-maintenance'
import { syncProviderPlans } from '@/lib/actions/provider-sync'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

export async function POST(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const action = body.action || 'maintenance'

  if (action === 'maintenance') {
    const result = await runProviderMaintenance()
    return NextResponse.json(result)
  }

  if (action === 'catalog-sync') {
    const dueIds = await getCatalogSyncDueProviders()
    const results: any[] = []
    for (const id of dueIds) {
      try {
        const r = await syncProviderPlans(id)
        results.push({ providerId: id, ...r })
      } catch (e: any) {
        results.push({ providerId: id, error: e.message })
      }
    }
    return NextResponse.json({ synced: results.length, results })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
