import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'

export default async function NewPackagePage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const providers = await prisma.provider.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/packages" className="text-sm text-blue-600 hover:underline">
          ← Back to Packages
        </Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Create New Package</h2>
        <p className="text-gray-600">Add a new eSIM data plan</p>
      </div>

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form action="/api/packages" method="POST" className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Package Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              placeholder="e.g., Africa 10GB - 30 Days"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              placeholder="Brief description of the package"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="dataGB" className="block text-sm font-medium text-gray-700">
                Data (GB)
              </label>
              <input
                id="dataGB"
                name="dataGB"
                type="number"
                required
                min="1"
                placeholder="10"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="validityDays" className="block text-sm font-medium text-gray-700">
                Validity (Days)
              </label>
              <input
                id="validityDays"
                name="validityDays"
                type="number"
                required
                min="1"
                placeholder="30"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="priceUSD" className="block text-sm font-medium text-gray-700">
                Price (USD)
              </label>
              <input
                id="priceUSD"
                name="priceUSD"
                type="number"
                required
                step="0.01"
                min="0"
                placeholder="29.99"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="localPrice" className="block text-sm font-medium text-gray-700">
                Local Price
              </label>
              <input
                id="localPrice"
                name="localPrice"
                type="number"
                required
                step="0.01"
                min="0"
                placeholder="29.99"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label htmlFor="currency" className="block text-sm font-medium text-gray-700">
              Currency
            </label>
            <input
              id="currency"
              name="currency"
              type="text"
              required
              defaultValue="USD"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="providerId" className="block text-sm font-medium text-gray-700">Provider</label>
            <select id="providerId" name="providerId" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">No provider</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="isActive"
              name="isActive"
              type="checkbox"
              defaultChecked={true}
              className="rounded border-gray-300"
            />
            <label htmlFor="isActive" className="text-sm text-gray-700">
              Active
            </label>
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Create Package
            </button>
            <a
              href="/admin/packages"
              className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </a>
          </div>
        </form>
      </div>
    </div>
  )
}
