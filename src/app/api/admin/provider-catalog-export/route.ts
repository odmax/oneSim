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

  const lines = [headers.join(',')]
  for (const pkg of packages) {
    const vals = [
      pkg.id, pkg.provider?.name || '', pkg.providerPlanId, pkg.providerPlanCode || '',
      pkg.name, pkg.country || '', pkg.region || '', pkg.dataGB, pkg.validityDays,
      pkg.costPrice.toString(), pkg.sellingPrice?.toString() || '', pkg.sellingCurrency || 'USD',
      pkg.markupPercent?.toString() || '', pkg.pricingMode || '',
      pkg.publishStatus || '', pkg.configurationStatus || '',
      Array.isArray(pkg.tags) ? (pkg.tags as string[]).join(';') : '', pkg.notes || '',
    ].map(v => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    })
    lines.push(vals.join(','))
  }

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="provider-catalog-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
