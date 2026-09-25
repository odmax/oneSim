import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { deriveUsageMetrics, getUsageStaleness, usageUsedLabel, usageRemainingLabel } from '@/lib/esim/usage-metrics'
import { sanitizePublicText } from '@/lib/catalog/public-package-presentation'
import { deriveEsimLifecyclePresentation } from '@/lib/esim/lifecycle-presentation'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

function UsagePill({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  const color = pct > 80 ? 'bg-red-100 text-red-700' : pct > 50 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {pct}%
    </span>
  )
}

function StatusPill({ title, label, tone }: { title?: string; label: string; tone: string }) {
  const toneClasses: Record<string, string> = {
    success: 'bg-emerald-50 text-emerald-600',
    warn: 'bg-amber-50 text-amber-600',
    danger: 'bg-red-50 text-red-600',
    neutral: 'bg-gray-50 text-gray-600',
  }
  const dotClasses: Record<string, string> = {
    success: 'bg-emerald-400',
    warn: 'bg-amber-400',
    danger: 'bg-red-400',
    neutral: 'bg-gray-400',
  }
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses[tone] || 'bg-gray-50 text-gray-600'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotClasses[tone] || 'bg-amber-400'}`} />
      {label}
    </span>
  )
}

/** Two-axis presentation for the usage table: Service + Setup. */
function LifecyclePills({ esim }: { esim: any }) {
  const p = deriveEsimLifecyclePresentation({
    status: esim.status,
    installationStatus: esim.installationStatus,
    hasUsableInstallData: hasUsableInstallData(esim),
    activatedAt: esim.activatedAt,
    activationDetectedAt: esim.activationDetectedAt,
    dataUsedMB: esim.dataUsedMB,
  })
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusPill title="Service status" label={p.serviceLabel} tone={p.serviceTone} />
      <StatusPill title="Setup status" label={p.setupLabel} tone={p.setupTone} />
    </div>
  )
}

export default async function BusinessUsagePage({ searchParams }: { searchParams: { status?: string; search?: string; customerId?: string; packageId?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!

  const esimWhere: any = { purchase: { businessId } }
  if (searchParams.status) esimWhere.status = searchParams.status
  if (searchParams.search) {
    esimWhere.OR = [
      { iccid: { contains: searchParams.search, mode: 'insensitive' } },
      { imsi: { contains: searchParams.search, mode: 'insensitive' } },
    ]
  }
  if (searchParams.customerId) esimWhere.customerId = searchParams.customerId

  const [esims, customers, packages] = await Promise.all([
    prisma.eSIM.findMany({
      where: esimWhere,
      include: {
        purchase: { include: { package: true } },
        customer: true,
        usageRecords: { orderBy: { timestamp: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.customer.findMany({ where: { businessId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.eSIMPurchase.findMany({
      where: { businessId },
      include: { package: true },
      distinct: ['packageId'],
    }),
  ])

  // CURRENT usage derives from the canonical ESIM snapshot columns; UsageRecord
  // is historical. eSIMs without a snapshot are UNKNOWN, never shown as 0 MB;
  // a stored numeric zero is a real zero and counted as known-zero usage.
  const usageKnownEsims = esims.filter((e) => e.dataUsedMB != null)
  const totalDataUsed = usageKnownEsims.reduce((sum, e) => sum + e.dataUsedMB, 0)
  const activeCount = esims.filter((e) => e.status === 'ACTIVE').length
  const expiringSoon = esims.filter((e) => e.expiresAt && e.expiresAt < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) && e.expiresAt > new Date()).length
  const hasSnapshot = (e: any) => e.dataTotalMB != null || e.dataRemainingMB != null
  const zeroUsage = esims.filter((e) => hasSnapshot(e) && e.dataUsedMB === 0).length
  const unknownUsage = esims.filter((e) => !hasSnapshot(e)).length

  const uniquePkgs = packages.map((p) => p.package).filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">eSIM Usage Analysis</h2>
        <p className="mt-1 text-sm text-gray-500">Monitor data consumption across all your eSIMs</p>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total Data Used</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{(totalDataUsed / 1024).toFixed(1)} <span className="text-sm font-normal text-gray-500">GB</span></p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Active eSIMs</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600">{activeCount}<span className="text-sm font-normal text-gray-400 ml-1">/ {esims.length}</span></p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Expiring Soon</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{expiringSoon}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Zero Usage</p>
          <p className="mt-1 text-2xl font-bold text-gray-500">{zeroUsage}<span className="text-sm font-normal text-gray-400 ml-1">known 0 MB</span></p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Unknown Usage</p>
          <p className="mt-1 text-2xl font-bold text-gray-500">{unknownUsage}<span className="text-sm font-normal text-gray-400 ml-1">no snapshot</span></p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Avg per eSIM (known usage)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{usageKnownEsims.length > 0 ? Math.round(totalDataUsed / usageKnownEsims.length) : 0} <span className="text-sm font-normal text-gray-500">MB</span></p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <form className="flex flex-wrap gap-3">
          <div className="min-w-[160px] flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Search ICCID/IMSI</label>
            <input type="text" name="search" defaultValue={searchParams.search} placeholder="Search..." className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
          </div>
          <div className="min-w-[140px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select name="status" defaultValue={searchParams.status} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none">
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING_ACTIVATION">Pending</option>
              <option value="DEPLETED">Depleted</option>
              <option value="EXPIRED">Expired</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
            <select name="customerId" defaultValue={searchParams.customerId} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none">
              <option value="">All Customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Filter</button>
          </div>
        </form>
      </div>

      {/* Data Table */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50/50">
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Customer</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Data Used</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Remaining</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Usage %</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Expires</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {esims.length === 0 ? (
                <tr><td colSpan={9} className="px-5 py-12 text-center text-sm text-gray-400">No eSIMs found matching your filters.</td></tr>
              ) : esims.map((esim) => {
                const current = deriveUsageMetrics(esim.dataUsedMB, esim.dataTotalMB, esim.dataRemainingMB)
                const staleness = getUsageStaleness(esim.lastUsageSyncAt)
                return (
                  <tr key={esim.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="whitespace-nowrap px-5 py-4 text-sm">
                      {esim.customer ? (
                        <div>
                          <div className="font-medium text-gray-900">{esim.customer.name}</div>
                          <div className="text-xs text-gray-500">{esim.customer.email}</div>
                        </div>
                      ) : (
                        <span className="text-gray-400 italic">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-mono text-gray-900">{esim.iccid}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-700">
                      {sanitizePublicText(esim.purchase.package.displayName || esim.purchase.package.name, null, esim.purchase.package.providerName) || esim.purchase.package.displayName || esim.purchase.package.name}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-900">
                      {usageUsedLabel(current)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-900">
                      {usageRemainingLabel(current)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      {current.hasSnapshot && current.usedKnown && current.total > 0 ? <UsagePill value={current.used} total={current.total} /> : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">
                      {esim.expiresAt ? new Date(esim.expiresAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <LifecyclePills esim={esim} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-xs text-gray-400">
                      {esim.lastUsageSyncAt ? (
                        <span className={staleness.stale ? 'text-orange-500' : 'text-gray-400'} title={staleness.stale ? 'Data may be out of date (last-known)' : 'Fresh'}>
                          {new Date(esim.lastUsageSyncAt).toLocaleDateString()}{staleness.stale ? ' (stale)' : ''}
                        </span>
                      ) : 'Never'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}