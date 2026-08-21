export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

/**
 * Minimal order status endpoint for Buy-flow polling. Returns ONLY the order
 * status and eSIM count — never provider fields or internal metadata.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return NextResponse.json({ success: false, error: 'Not authorized' }, { status: 401 })
  }

  const order = await prisma.eSIMPurchase.findFirst({
    where: { id: params.id, businessId: session.user.businessId! },
    select: { id: true, status: true, _count: { select: { esims: true } } },
  })

  if (!order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    orderId: order.id,
    status: order.status,
    esimCount: order._count.esims,
  })
}
