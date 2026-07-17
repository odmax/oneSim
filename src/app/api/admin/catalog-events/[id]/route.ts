import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { retryEvent, cancelEvent, replayEvent } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
