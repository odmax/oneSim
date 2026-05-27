import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateBusiness } from '@/lib/actions/business'

export default async function EditBusinessPage({ 
  params 
}: { 
  params: { id: string } 
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const business = await prisma.business.findUnique({
    where: { id: params.id }
  })

  if (!business) {
    redirect('/admin/businesses')
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href={`/admin/businesses/${business.id}`} className="text-sm text-blue-600 hover:underline">
          ← Back to Business Details
        </Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Edit Business</h2>
        <p className="text-gray-600">{business.name}</p>
      </div>

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form action={updateBusiness} className="space-y-4">
          <input type="hidden" name="businessId" value={business.id} />
          
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Company Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              defaultValue={business.name}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="regNumber" className="block text-sm font-medium text-gray-700">
              Registration Number
            </label>
            <input
              id="regNumber"
              name="regNumber"
              type="text"
              defaultValue={business.regNumber || ''}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="taxId" className="block text-sm font-medium text-gray-700">
              Tax ID
            </label>
            <input
              id="taxId"
              name="taxId"
              type="text"
              defaultValue={business.taxId || ''}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="contactEmail" className="block text-sm font-medium text-gray-700">
              Contact Email
            </label>
            <input
              id="contactEmail"
              name="contactEmail"
              type="email"
              required
              defaultValue={business.contactEmail}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="contactPhone" className="block text-sm font-medium text-gray-700">
              Contact Phone
            </label>
            <input
              id="contactPhone"
              name="contactPhone"
              type="tel"
              defaultValue={business.contactPhone || ''}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="country" className="block text-sm font-medium text-gray-700">
              Country
            </label>
            <input
              id="country"
              name="country"
              type="text"
              required
              defaultValue={business.country}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="address" className="block text-sm font-medium text-gray-700">
              Address
            </label>
            <textarea
              id="address"
              name="address"
              rows={3}
              defaultValue={business.address || ''}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="status" className="block text-sm font-medium text-gray-700">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={business.status}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            >
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Save Changes
            </button>
            <a
              href={`/admin/businesses/${business.id}`}
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
