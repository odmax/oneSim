import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getDeadLetterEvents, replayDeadLetter, deleteDeadLetter } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const events = await getDeadLetterEvents()
  return NextResponse.json({ events })
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
