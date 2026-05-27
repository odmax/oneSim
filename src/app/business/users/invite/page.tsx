import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { addTeamMember } from '@/lib/actions/business-users'

export default async function InviteUserPage({ searchParams }: { searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  if (session.user.businessRole !== 'ADMIN') {
    redirect('/business/users')
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Invite Team Member</h2>
        <p className="text-gray-600">Add a new member to your business</p>
      </div>

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}

      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {decodeURIComponent(searchParams.success)}
        </div>
      )}

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form action={async (formData) => {
          'use server'
          const result = await addTeamMember(formData)
          if (result?.error) {
            redirect(`/business/users/invite?error=${encodeURIComponent(result.error)}`)
          }
          if (result?.success) {
            redirect(`/business/users/invite?success=${encodeURIComponent(result.success)}`)
          }
          redirect(`/business/users/invite?error=Failed+to+create+team+member`)
        }} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Full Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              placeholder="John Doe"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email Address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              placeholder="john@company.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Temporary Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
              placeholder="Minimum 8 characters"
            />
          </div>

          <div>
            <label htmlFor="role" className="block text-sm font-medium text-gray-700">
              Permission Role
            </label>
            <select
              id="role"
              name="role"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
            >
              <option value="">Select a role</option>
              <option value="MEMBER">Member (Read-only)</option>
              <option value="ADMIN">Admin (Full access)</option>
            </select>
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Add Member
            </button>
            <a
              href="/business/users"
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
