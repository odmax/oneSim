import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { getDeadLetterEvents, replayDeadLetter, deleteDeadLetter } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const events = await getDeadLetterEvents()
  return NextResponse.json({ events })
}

export async function POST(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PRODUCTS)
  if (!allowed) return denied

  const body = await request.json().catch(() => ({}))
  const deadLetterId = body.id
  const action = body.action || 'replay'

  if (!deadLetterId) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  if (action === 'replay') {
    const ok = await replayDeadLetter(deadLetterId)
    return NextResponse.json({ success: ok })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
