export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { validatePurchaseQuote } from '@/lib/pricing/purchase-quote-service'

export async function GET(_req: NextRequest, { params }: { params: { quoteReference: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await validatePurchaseQuote(params.quoteReference, session.user.businessId)
  if (!result.valid) return NextResponse.json({ error: result.error }, { status: 404 })

  const q = result.quote!
  return NextResponse.json({
    quoteReference: q.quoteReference,
    quantity: q.quantity,
    unitPrice: q.unitPrice,
    totalAmount: q.totalAmount,
    currency: q.currency,
    status: q.status,
    expiresAt: q.expiresAt,
  })
}
