export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getSkuExportData, skuToJson } from '@/lib/services/exports/sku-export'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const data = await getSkuExportData()
  const json = skuToJson(data)

  return new NextResponse(json, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="onesim-sku-list.json"',
    },
  })
}
