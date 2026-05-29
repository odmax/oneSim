import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { renderToBuffer } from '@react-pdf/renderer'
import DeveloperDocsPDF from '@/lib/pdf/DeveloperDocsPDF'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session || !['BUSINESS_USER', 'SUPER_ADMIN', 'ADMIN'].includes(session.user.role)) {
      return new NextResponse('Unauthorized', { status: 401 })
    }

    const packages = await prisma.eSIMPackage.findMany({
      where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
      orderBy: { priceUSD: 'asc' },
      select: {
        id: true,
        name: true,
        dataGB: true,
        validityDays: true,
        priceUSD: true,
        description: true,
      },
    })

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://staging.onetelecom.cloud'

    const pdfBuffer = await renderToBuffer(
      <DeveloperDocsPDF
        packages={packages.map(p => ({ ...p, priceUSD: p.priceUSD.toString() }))}
        baseUrl={baseUrl}
      />
    )

    if (!pdfBuffer || pdfBuffer.length === 0) {
      return new NextResponse('Generated PDF is empty', { status: 500 })
    }

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="OneSim-Developer-API-Documentation.pdf"',
      },
    })
  } catch (error) {
    console.error('PDF generation error:', error)
    return new NextResponse(
      `Error generating PDF: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { status: 500 }
    )
  }
}
