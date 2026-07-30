export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { createPurchaseQuote } from '@/lib/pricing/purchase-quote-service'

export async function POST(req: NextRequest, { params }: { params: { packageId: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { quantity = 1, customerId } = await req.json().catch(() => ({}))
  if (!quantity || quantity < 1 || quantity > 100) return NextResponse.json({ error: 'Invalid quantity (1-100)' }, { status: 400 })

  const result = await createPurchaseQuote({
    businessId: session.user.businessId,
    providerPackageId: params.packageId,
    quantity,
  })

  if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result.quote)
}
