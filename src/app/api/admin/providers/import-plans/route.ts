export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { importProviderPlans } from '@/lib/actions/provider-import'
import type { ImportResult } from '@/lib/providers/plan-utils'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function POST(request: Request) {
  try {
    const { allowed, denied, session } = await adminApiAccess(Permissions.MANAGE_PROVIDERS)
    if (!allowed || !session) return denied

    const body = await request.json()
    const { providerId, plans } = body

    if (!providerId || !plans || !Array.isArray(plans)) {
      return NextResponse.json({ error: 'Missing providerId or plans array' }, { status: 400 })
    }

    const { results } = await importProviderPlans(providerId, plans, session.user.id)
    return NextResponse.json({ results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Import failed' }, { status: 500 })
  }
}
