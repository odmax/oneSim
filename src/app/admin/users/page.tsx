import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { toggleAdminStatus, deleteAdminUser } from '@/lib/actions/admin-users'
import { ADMIN_PERMISSIONS } from '@/lib/auth/admin-permissions'
import { ConfirmForm } from '@/components/admin/providers/ConfirmForm'

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    SUPER_ADMIN: 'bg-purple-50 text-purple-600',
    ADMIN: 'bg-blue-50 text-blue-600',
    OPERATIONS_MANAGER: 'bg-cyan-50 text-cyan-600',
    PRODUCT_MANAGER: 'bg-emerald-50 text-emerald-600',
    SUPPORT_MANAGER: 'bg-amber-50 text-amber-600',
    SUPPORT_AGENT: 'bg-orange-50 text-orange-600',
    FINANCE_MANAGER: 'bg-green-50 text-green-600',
    ANALYTICS_MANAGER: 'bg-indigo-50 text-indigo-600',
    READ_ONLY: 'bg-gray-50 text-gray-500',
  }
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[role] || 'bg-gray-50 text-gray-500'}`}>{role.replace('_', ' ')}</span>
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500">{label}</p><p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p></div>
}

export default async function AdminUsersPage({ searchParams }: { searchParams?: { q?: string; role?: string; error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  const isSuperAdmin = currentAdmin?.role === 'SUPER_ADMIN'

  const q = searchParams?.q?.trim()
  const roleFilter = searchParams?.role

  const where: any = {}
  if (roleFilter) where.role = roleFilter
  if (q) where.OR = [{ user: { name: { contains: q, mode: 'insensitive' } } }, { user: { email: { contains: q, mode: 'insensitive' } } }]

  const [users, totalCount, activeCount] = await Promise.all([
    prisma.internalAdmin.findMany({ where, include: { user: true }, orderBy: { createdAt: 'desc' } }),
    prisma.internalAdmin.count(),
    prisma.internalAdmin.count({ where: { isActive: true } }),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Admin Users</h2>
          <p className="mt-1 text-sm text-gray-500">Manage internal team members and permissions</p>
        </div>
        {isSuperAdmin && (
          <Link href="/admin/users/new" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Add Admin User</Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Admins" value={String(totalCount)} color="text-gray-900" />
        <StatCard label="Active" value={String(activeCount)} color="text-emerald-600" />
        <StatCard label="Inactive" value={String(totalCount - activeCount)} color="text-red-600" />
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <form method="GET" action="/admin/users" className="flex flex-wrap gap-3 items-end">
          <div className="min-w-[240px] flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <input name="q" type="text" defaultValue={q || ''} placeholder="Search by name or email..."
              className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
            <select name="role" defaultValue={roleFilter || ''}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
              <option value="">All Roles</option>
              <option value="SUPER_ADMIN">Super Admin</option>
              <option value="ADMIN">Admin</option>
              <option value="OPERATIONS_MANAGER">Operations Manager</option>
              <option value="PRODUCT_MANAGER">Product Manager</option>
              <option value="SUPPORT_MANAGER">Support Manager</option>
              <option value="SUPPORT_AGENT">Support Agent</option>
              <option value="FINANCE_MANAGER">Finance Manager</option>
              <option value="ANALYTICS_MANAGER">Analytics Manager</option>
              <option value="READ_ONLY">Read Only</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Search</button>
          {(q || roleFilter) && <Link href="/admin/users" className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Clear</Link>}
        </form>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}
      {searchParams?.success && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>}

      {users.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No admin users found.</p>
          {(q || roleFilter) && <Link href="/admin/users" className="mt-3 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-700">Clear filters →</Link>}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Name</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Email</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Role</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Permissions</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
                  {isSuperAdmin && <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4 font-medium text-gray-900">{u.user.name}</td>
                    <td className="px-5 py-4 text-gray-600">{u.user.email}</td>
                    <td className="px-5 py-4"><RoleBadge role={u.role} /></td>
                    <td className="px-5 py-4 text-xs text-gray-500">{Array.isArray(u.permissions) ? u.permissions.length : 0} permissions</td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${u.isActive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${u.isActive ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {u.isActive ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-gray-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                    {isSuperAdmin && (
                      <td className="px-5 py-4">
                        <div className="flex gap-1.5">
                          <Link href={`/admin/users/${u.id}`} className="rounded-md bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">View</Link>
                          <Link href={`/admin/users/${u.id}/edit`} className="rounded-md bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">Edit</Link>
                          {u.id !== currentAdmin?.id && (
                            <>
                              <form action={toggleAdminStatus.bind(null, u.id)}>
                                <button type="submit" className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${u.isActive ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                                  {u.isActive ? 'Suspend' : 'Activate'}
                                </button>
                              </form>
                              <ConfirmForm action={deleteAdminUser.bind(null, u.id)} message={`Delete ${u.user.name}? This cannot be undone.`}>
                                <button type="submit" className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Delete</button>
                              </ConfirmForm>
                            </>
                          )}
                        </div>
                      </td>
                    )}
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
