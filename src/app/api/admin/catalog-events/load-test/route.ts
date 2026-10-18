import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { simulatePackageUpdates } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PRODUCTS)
  if (!allowed) return denied

  const body = await request.json().catch(() => ({}))
  const count = Math.min(body.count || 100, 10000)
  const keys = body.keys || ['local:NG:5GB:30', 'local:KE:1GB:7', 'roaming:INT:10GB:30']

  const result = await simulatePackageUpdates(count, keys)
  return NextResponse.json(result)
}
