import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getSkuExportData, skuToCsv } from '@/lib/services/exports/sku-export'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const data = await getSkuExportData()
  const csv = skuToCsv(data)

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="onesim-sku-list.csv"',
    },
  })
}
