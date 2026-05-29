import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createBusiness } from '@/lib/actions/business'

export default async function NewBusinessPage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const users = await prisma.user.findMany({
    where: { 
      role: 'BUSINESS_USER',
      businessUsers: { none: {} }
    },
    select: { id: true, name: true, email: true }
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/businesses" className="text-sm text-cyan-600 hover:underline">
          ← Back to Businesses
        </Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Add New Business</h2>
        <p className="text-gray-600">Create a new business and assign a primary contact</p>
      </div>

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form action={createBusiness} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Company Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              placeholder="Acme Corporation"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="REG123456"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="TAX123456"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="contact@company.com"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="+1234567890"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="South Africa"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
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
              placeholder="123 Main St, Cape Town, South Africa"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div className="border-t pt-4">
            <h3 className="mb-2 text-sm font-medium text-gray-700">Business Admin Account (Required)</h3>
            <p className="mb-4 text-sm text-gray-500">
              This admin user will be able to login and manage the business.
            </p>
            
            <div className="space-y-4">
              <div>
                <label htmlFor="adminName" className="block text-sm font-medium text-gray-700">
                  Admin Full Name *
                </label>
                <input
                  id="adminName"
                  name="adminName"
                  type="text"
                  required
                  placeholder="John Doe"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="adminEmail" className="block text-sm font-medium text-gray-700">
                  Admin Email * (must be unique)
                </label>
                <input
                  id="adminEmail"
                  name="adminEmail"
                  type="email"
                  required
                  placeholder="admin@company.com"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="sendInvite" className="flex items-center gap-2 cursor-pointer">
                  <input id="sendInvite" name="sendInvite" type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                  <span className="text-sm font-medium text-gray-700">Send invite email to set password</span>
                </label>
                <p className="mt-1 text-xs text-gray-400">User will receive an email with a link to create their password.</p>
              </div>

              <div>
                <label htmlFor="adminPassword" className="block text-sm font-medium text-gray-700">
                  Temporary Password <span className="text-gray-400">(optional if invite is sent)</span>
                </label>
                <input
                  id="adminPassword"
                  name="adminPassword"
                  type="password"
                  minLength={8}
                  placeholder="Leave blank to send invite"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="status" className="block text-sm font-medium text-gray-700">
                  Initial Status
                </label>
                <select
                  id="status"
                  name="status"
                  defaultValue="PENDING"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
                >
                  <option value="PENDING">Pending Approval</option>
                  <option value="APPROVED">Approved (Can login immediately)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Create Business & Admin Account
            </button>
            <Link
              href="/admin/businesses"
              className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
