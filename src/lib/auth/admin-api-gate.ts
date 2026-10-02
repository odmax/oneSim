import { NextResponse } from 'next/server'
import type { Session } from 'next-auth'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { canAccessAdmin, type Capability } from '@/lib/auth/permissions'

export interface AdminApiGate {
  allowed: boolean
  /** Session is non-null whenever allowed is true. */
  session: Session | null
  denied: NextResponse
}

/**
 * DB-backed capability gate for admin REST APIs. Stale session claims cannot
 * retain removed permissions: the CURRENT database InternalAdmin row decides.
 */
export async function adminApiAccess(capability: Capability): Promise<AdminApiGate> {
  const denied = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) {
    return { allowed: false, session: null, denied: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const allowed = await canAccessAdmin(session.user.id, capability)
  return { allowed, session, denied }
}