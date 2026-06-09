import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function AdminEsimUsagePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.id },
    include: {
      purchase: { include: { business: true, package: true } },
      usageRecords: { orderBy: { timestamp: 'desc' } },
    },
  })

  if (!esim) redirect('/admin/esims')

  const totalUsed = esim.usageRecords.reduce((s, r) => s + r.dataUsedMB, 0)
  const latestRecord = esim.usageRecords[0]
  const dataGB = esim.packageDataGB || esim.purchase.packageDataGB || esim.purchase.package.dataGB || 0
  const totalMB = esim.dataTotalMB || (dataGB * 1024) || 0
  const remainingMB = esim.dataRemainingMB ?? (totalMB - totalUsed)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/esims" className="text-sm text-cyan-600 hover:underline">← Back to All eSIMs</Link>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">eSIM Usage Details</h2>
          <p className="text-sm text-gray-500 font-mono">{esim.iccid}</p>
        </div>
        <Link href={`/admin/esims/${params.id}`} className="text-sm text-cyan-600 hover:underline">View eSIM Detail →</Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Summary</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Business</dt><dd className="font-medium text-gray-900">{esim.purchase.business.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Package</dt><dd className="font-medium text-gray-900">{esim.packageName || esim.purchase.package.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd><span className="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-800">{esim.status}</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Total Data</dt><dd className="font-medium text-gray-900">{totalMB > 0 ? `${(totalMB / 1024).toFixed(2)} GB` : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Data Used</dt><dd className="font-medium text-gray-900">{(totalUsed / 1024).toFixed(2)} GB</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Data Remaining</dt><dd className={`font-medium ${remainingMB > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{Math.max(0, remainingMB / 1024).toFixed(2)} GB</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Usage %</dt><dd><span className={`font-medium ${totalMB > 0 && (totalUsed / totalMB) > 0.8 ? 'text-red-600' : 'text-gray-900'}`}>{totalMB > 0 ? Math.round((totalUsed / totalMB) * 100) : 0}%</span></dd></div>
            {esim.expiresAt && <div className="flex justify-between"><dt className="text-gray-500">Expires</dt><dd className="text-gray-900">{new Date(esim.expiresAt).toLocaleDateString()}</dd></div>}
            {esim.lastUsageSyncAt && <div className="flex justify-between"><dt className="text-gray-500">Last Synced</dt><dd className="text-gray-500">{new Date(esim.lastUsageSyncAt).toLocaleString()}</dd></div>}
          </dl>
        </div>

        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Usage History</h3>
          {esim.usageRecords.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-400">No usage records yet.</p>
              <p className="text-xs text-gray-400 mt-1">Usage data appears after the eSIM is activated and used on a device.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {esim.usageRecords.map((r, i) => (
                <div key={r.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400 text-xs">#{i + 1}</span>
                    <span className="font-medium text-gray-900">{r.dataUsedMB} MB</span>
                  </div>
                  <span className="text-xs text-gray-500">{new Date(r.timestamp).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}