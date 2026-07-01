import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getSkuExportData, skuToXlsx } from '@/lib/services/exports/sku-export'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const data = await getSkuExportData()
  const html = skuToXlsx(data)

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': 'attachment; filename="onesim-sku-list.xls"',
    },
  })
}
