import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { createOrder } from '@/lib/services/orders/create-order'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { packageId, quantity = 1 } = body
    const busId = session.user.businessId

    if (!busId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!packageId) {
      return NextResponse.json({ error: 'Package ID required' }, { status: 400 })
    }

    const result = await createOrder({
      businessId: busId,
      userId: session.user.id,
      packageId,
      quantity,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.errorStatus || 500 },
      )
    }

    return NextResponse.json({
      success: true,
      purchase: {
        id: result.orderId,
        status: result.status,
      },
      esims: result.esims,
    })
  } catch (error) {
    console.error('Purchase error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
