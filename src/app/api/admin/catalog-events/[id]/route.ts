import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { retryEvent, cancelEvent, replayEvent } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PRODUCTS)
  if (!allowed) return denied

  const body = await request.json().catch(() => ({}))
  const action = body.action || 'retry'

  const eventId = params.id

  switch (action) {
    case 'retry': {
      const ok = await retryEvent(eventId)
      return NextResponse.json({ success: ok })
    }
    case 'cancel': {
      const ok = await cancelEvent(eventId)
      return NextResponse.json({ success: ok })
    }
    case 'replay': {
      const ok = await replayEvent(eventId)
      return NextResponse.json({ success: ok })
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }
}
