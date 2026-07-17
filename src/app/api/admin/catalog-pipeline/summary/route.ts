import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getPipelineSummary, runCatalogHealthDiagnostics } from '@/lib/catalog-pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const providerId = searchParams.get('providerId') || undefined

  try {
    const summary = await getPipelineSummary(providerId)
    const health = await runCatalogHealthDiagnostics(providerId)

    return NextResponse.json({
      ...summary,
      currentHealth: health,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to fetch summary' }, { status: 500 })
  }
}
