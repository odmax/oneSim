import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { updateBusiness } from '@/lib/actions/business'

export default async function ProfilePage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const user = await prisma.businessUser.findUnique({
    where: { id: session.user.id },
    include: { business: true, user: true }
  })

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">My Profile</h2>
        <p className="text-gray-600">Manage your account settings</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold">Personal Information</h3>
          <form action={updateBusiness} className="space-y-4">
            <input type="hidden" name="businessId" value={session.user.businessId!} />
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
              <input
                id="name"
                name="name"
                type="text"
                defaultValue={user.user?.name || ''}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={user.user?.email || ''}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Role</label>
              <p className="mt-1 text-sm text-gray-900">{user.role}</p>
            </div>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Update Profile
            </button>
          </form>
        </div>

        <div className="rounded-lg border bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold">Business Information</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Company</label>
              <p className="mt-1 text-sm text-gray-900">{user.business.name}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Email</label>
              <p className="mt-1 text-sm text-gray-900">{user.business.contactEmail}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Phone</label>
              <p className="mt-1 text-sm text-gray-900">{user.business.contactPhone || 'N/A'}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Country</label>
              <p className="mt-1 text-sm text-gray-900">{user.business.country}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Status</label>
              <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                user.business.status === 'APPROVED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}>
                {user.business.status}
              </span>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Wallet Balance</label>
              <p className="mt-1 text-lg font-bold text-gray-900">${user.business.walletBalance.toFixed(2)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
