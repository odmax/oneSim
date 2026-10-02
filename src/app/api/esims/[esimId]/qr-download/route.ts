export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { buildInstallationPresentation } from '@/lib/esim/installation-data'
import { renderQrPayload } from '@/lib/esim/qr-encoder'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function GET(request: Request, { params }: { params: { esimId: string } }) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.esimId },
    select: { iccid: true, qrCodeUrl: true, qrCode: true, activationCode: true, smdpAddress: true, matchingId: true, purchase: { select: { businessId: true } } },
  })

  if (!esim) {
    return NextResponse.json({ error: 'eSIM not found' }, { status: 404 })
  }

  // Security: business users can only access their own eSIMs
  if (session.user.role === 'BUSINESS_USER') {
    if (esim.purchase.businessId !== session.user.businessId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
  } else if (session.user.role === 'INTERNAL_ADMIN') {
    // DB-backed: stale permission claims cannot grant admin QR downloads.
    const { allowed, denied } = await adminApiAccess(Permissions.VIEW_ESIMS)
    if (!allowed) return denied
  }

  // Canonical classification: an image URL is fetched; an LPA payload is rendered
  // locally into an SVG data URL (never uploaded to an external QR service).
  const install = buildInstallationPresentation({
    activationCode: esim.activationCode,
    qrCodeUrl: esim.qrCodeUrl,
    qrCode: esim.qrCode,
    smdpAddress: esim.smdpAddress,
    matchingId: esim.matchingId,
  })

  const filename = `esim-${esim.iccid.slice(-8)}-qr`

  if (install.qrImageUrl) {
    try {
      const response = await fetch(install.qrImageUrl)
      if (!response.ok) {
        return NextResponse.json({ error: 'Failed to fetch QR code' }, { status: 502 })
      }

      const blob = await response.blob()
      return new NextResponse(blob, {
        headers: {
          'Content-Type': response.headers.get('content-type') || 'image/png',
          'Content-Disposition': `attachment; filename="${filename}.png"`,
          'Cache-Control': 'public, max-age=3600',
        },
      })
    } catch {
      return NextResponse.redirect(install.qrImageUrl)
    }
  }

  // Local QR rendering from the payload — no provider call, no external service.
  const payload = install.qrPayload
  if (payload) {
    const svgDataUrl = renderQrPayload(payload)
    // The SVG data URL is `data:image/svg+xml;base64,...` — return it as a
    // downloadable SVG file.
    const base64 = svgDataUrl.split(',')[1] || ''
    const svg = Buffer.from(base64, 'base64').toString('utf8')
    return new NextResponse(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Disposition': `attachment; filename="${filename}.svg"`,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  // Manual install data (SM-DP+ / activation code) — no QR image exists yet.
  if (install.smdpAddress && install.matchingId) {
    return NextResponse.json({ error: 'Manual installation only (no QR image or payload available)' }, { status: 404 })
  }

  return NextResponse.json({ error: 'No QR code available' }, { status: 404 })
}
