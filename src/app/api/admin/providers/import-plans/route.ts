export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { importProviderPlans } from '@/lib/actions/provider-import'
import type { ImportResult } from '@/lib/providers/plan-utils'

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
