import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { deleteDeadLetter } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PRODUCTS)
  if (!allowed) return denied

  const ok = await deleteDeadLetter(params.id)
  return NextResponse.json({ success: ok })
}
