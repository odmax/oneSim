import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { getEventDiagnostic } from '@/lib/catalog-workers'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const { searchParams } = new URL(request.url)
  const eventId = searchParams.get('eventId')
  if (!eventId) {
    return NextResponse.json({ error: 'Missing eventId parameter' }, { status: 400 })
  }

  const diagnostic = await getEventDiagnostic(eventId)
  if (!diagnostic) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  return NextResponse.json(diagnostic)
}
