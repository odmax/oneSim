import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { simulatePackageUpdates } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const count = Math.min(body.count || 100, 10000)
  const keys = body.keys || ['local:NG:5GB:30', 'local:KE:1GB:7', 'roaming:INT:10GB:30']

  const result = await simulatePackageUpdates(count, keys)
  return NextResponse.json(result)
}
