import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const packages = await prisma.providerPackage.findMany({
    include: { provider: { select: { name: true } } },
    orderBy: [{ providerId: 'asc' }, { name: 'asc' }],
  })

  const headers = [
    'providerPackageId', 'providerName', 'providerPlanId', 'providerPlanCode',
    'name', 'country', 'region', 'dataGB', 'validityDays', 'costPrice',
    'sellingPrice', 'sellingCurrency', 'markupPercent', 'pricingMode',
    'publishStatus', 'configurationStatus', 'tags', 'notes',
  ]

  let html = '<html><body><table>'
  html += '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>'
  for (const pkg of packages) {
    const vals = [
      pkg.id, pkg.provider?.name || '', pkg.providerPlanId, pkg.providerPlanCode || '',
      pkg.name, pkg.country || '', pkg.region || '', pkg.dataGB, pkg.validityDays,
      pkg.costPrice?.toString() || '', pkg.sellingPrice?.toString() || '', pkg.sellingCurrency || 'USD',
      pkg.markupPercent?.toString() || '', pkg.pricingMode || '',
      pkg.publishStatus || '', pkg.configurationStatus || '',
      Array.isArray(pkg.tags) ? (pkg.tags as string[]).join(';') : '', pkg.notes || '',
    ]
    html += '<tr>' + vals.map(v => `<td>${String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`).join('') + '</tr>'
  }
  html += '</table></body></html>'

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': `attachment; filename="provider-catalog-${new Date().toISOString().slice(0, 10)}.xls"`,
    },
  })
}
