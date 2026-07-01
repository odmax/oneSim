import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { getSkuExportData } from '@/lib/services/exports/sku-export'
import Link from 'next/link'

export default async function SkuDownloadsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const data = await getSkuExportData()
  const lastUpdated = new Date().toLocaleString()
  const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ''

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">SKU Downloads</h2>
        <p className="mt-1 text-sm text-gray-500">Download the full OneSim catalog as JSON, CSV, or Excel to import into your systems.</p>
      </div>

      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Catalog Export</h3>
            <p className="text-xs text-gray-500 mt-1">{data.length} active SKUs available</p>
            <p className="text-xs text-gray-400">Last updated: {lastUpdated}</p>
          </div>
        </div>

        {data.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
            <p className="text-gray-500">No SKUs available for download at this time.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <a href="/api/business/sku-downloads/json"
              className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 p-6 hover:border-emerald-300 hover:bg-emerald-50 transition-all group">
              <span className="text-3xl">{'{ }'}</span>
              <span className="font-semibold text-gray-900 group-hover:text-emerald-700">Download JSON</span>
              <span className="text-xs text-gray-400">onesim-sku-list.json</span>
            </a>

            <a href="/api/business/sku-downloads/csv"
              className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 p-6 hover:border-blue-300 hover:bg-blue-50 transition-all group">
              <span className="text-3xl">CSV</span>
              <span className="font-semibold text-gray-900 group-hover:text-blue-700">Download CSV</span>
              <span className="text-xs text-gray-400">onesim-sku-list.csv</span>
            </a>

            <a href="/api/business/sku-downloads/xlsx"
              className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 p-6 hover:border-purple-300 hover:bg-purple-50 transition-all group">
              <span className="text-3xl">XLS</span>
              <span className="font-semibold text-gray-900 group-hover:text-purple-700">Download Excel</span>
              <span className="text-xs text-gray-400">onesim-sku-list.xls</span>
            </a>
          </div>
        )}

        <p className="mt-4 text-xs text-gray-400">Prices and availability may change. Download regularly or use the API for live catalog access.</p>
      </div>

      {/* API Endpoint Reference */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">API Endpoints</h3>
        <p className="text-xs text-gray-500 mb-3">Use these endpoints to automate SKU downloads from your scripts:</p>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
            <span className="text-gray-700">GET /api/business/sku-downloads/json</span>
            <button onClick={() => navigator.clipboard?.writeText(baseUrl + '/api/business/sku-downloads/json')}
              className="text-emerald-600 hover:text-emerald-700 font-medium">Copy</button>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
            <span className="text-gray-700">GET /api/business/sku-downloads/csv</span>
            <button onClick={() => navigator.clipboard?.writeText(baseUrl + '/api/business/sku-downloads/csv')}
              className="text-emerald-600 hover:text-emerald-700 font-medium">Copy</button>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
            <span className="text-gray-700">GET /api/business/sku-downloads/xlsx</span>
            <button onClick={() => navigator.clipboard?.writeText(baseUrl + '/api/business/sku-downloads/xlsx')}
              className="text-emerald-600 hover:text-emerald-700 font-medium">Copy</button>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-400">Requires authentication via session cookie (browser) or API key header (automated).</p>
      </div>

      {/* Table Preview */}
      {data.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">SKU Preview ({data.length} items)</h3>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">SKU</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Name</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Data</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Validity</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500">Price</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.map((item, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-900">{item.sku || item.packageCode || '—'}</td>
                    <td className="px-3 py-2 text-gray-900">{item.displayName || item.name}</td>
                    <td className="px-3 py-2 text-gray-600">{item.dataGB} GB</td>
                    <td className="px-3 py-2 text-gray-600">{item.validityDays}d</td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">${item.price.toFixed(2)}</td>
                    <td className="px-3 py-2"><span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-600">{item.productType}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
