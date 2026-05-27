import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { removeTeamMember } from '@/lib/actions/business-users'

export default async function UsersPage({ searchParams }: { searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const users = await prisma.businessUser.findMany({
    where: { businessId: session.user.businessId! },
    include: { user: true },
    orderBy: { createdAt: 'asc' }
  })

  const isAdmin = session.user.businessRole === 'ADMIN'

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Team Members</h2>
          <p className="text-gray-600">Manage your team members</p>
        </div>
        {isAdmin && (
          <Link href="/business/users/invite">
            <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Invite User
            </button>
          </Link>
        )}
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

      <div className="rounded-lg border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Email</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                {isAdmin && (
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((businessUser, index) => {
                const isMainAdmin = index === 0 && businessUser.role === 'ADMIN'
                const isSelf = businessUser.user.id === session.user.id
                
                return (
                  <tr key={businessUser.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                      {businessUser.user.name || 'N/A'}
                      {isSelf && <span className="ml-2 text-xs text-gray-500">(You)</span>}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {businessUser.user.email}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                        businessUser.role === 'ADMIN' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {businessUser.role}
                        {isMainAdmin && ' (Main)'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span className="inline-flex rounded-full px-2 py-1 text-xs font-semibold bg-green-100 text-green-800">
                        Active
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="whitespace-nowrap px-6 py-4 text-sm">
                          {!isSelf && !isMainAdmin && (
                            <form action={async (formData) => {
                              'use server'
                              const result = await removeTeamMember(businessUser.user.id)
                              if (result?.error) {
                                redirect(`/business/users?error=${encodeURIComponent(result.error)}`)
                              }
                              redirect('/business/users?success=Team+member+removed+successfully')
                            }}>
                              <button
                                type="submit"
                                className="text-red-600 hover:text-red-900"
                              >
                                Remove
                              </button>
                            </form>
                          )}
                      </td>
                    )}
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
