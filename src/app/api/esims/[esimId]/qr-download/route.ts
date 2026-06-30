import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request, { params }: { params: { esimId: string } }) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.esimId },
    select: { iccid: true, qrCodeUrl: true, purchase: { select: { businessId: true } } },
  })

  if (!esim) {
    return NextResponse.json({ error: 'eSIM not found' }, { status: 404 })
  }

  // Security: business users can only access their own eSIMs
  if (session.user.role === 'BUSINESS_USER') {
    if (esim.purchase.businessId !== session.user.businessId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
  }

  if (!esim.qrCodeUrl) {
    return NextResponse.json({ error: 'No QR code available' }, { status: 404 })
  }

  try {
    const response = await fetch(esim.qrCodeUrl)
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch QR code' }, { status: 502 })
    }

    const blob = await response.blob()
    const filename = `esim-${esim.iccid.slice(-8)}-qr.png`

    return new NextResponse(blob, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return NextResponse.redirect(esim.qrCodeUrl)
  }
}
