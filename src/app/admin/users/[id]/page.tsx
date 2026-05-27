import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ADMIN_PERMISSIONS } from '@/lib/auth/admin-permissions'

export default async function AdminUserDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const adminUser = await prisma.internalAdmin.findUnique({
    where: { id: params.id },
    include: { user: true },
  })
  if (!adminUser) redirect('/admin/users')

  const perms = (adminUser.permissions as string[]) || []
  const auditCount = await prisma.auditLog.count({ where: { userId: adminUser.userId } })

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/admin/users" className="text-sm text-gray-500 hover:text-gray-700">← Back to Admin Users</Link>

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-xl font-bold text-emerald-600">
              {adminUser.user.name?.charAt(0) || '?'}
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">{adminUser.user.name}</h2>
              <p className="text-sm text-gray-500">{adminUser.user.email}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={`/admin/users/${adminUser.id}/edit`} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Edit</Link>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Account Info</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Role</span><span className="font-medium text-gray-900">{adminUser.role.replace('_', ' ')}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Status</span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${adminUser.isActive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${adminUser.isActive ? 'bg-emerald-400' : 'bg-red-400'}`} />
                {adminUser.isActive ? 'Active' : 'Suspended'}
              </span>
            </div>
            <div className="flex justify-between"><span className="text-gray-500">Audit Events</span><span className="font-medium text-gray-900">{auditCount}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Created</span><span className="text-gray-700">{new Date(adminUser.createdAt).toLocaleDateString()}</span></div>
            {adminUser.lastLoginAt && <div className="flex justify-between"><span className="text-gray-500">Last Login</span><span className="text-gray-700">{new Date(adminUser.lastLoginAt).toLocaleDateString()}</span></div>}
          </div>
        </div>

        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Permissions</h3>
          <p className="text-xs text-gray-400 mb-3">{perms.length} of {ADMIN_PERMISSIONS.length} permissions granted</p>
          <div className="flex flex-wrap gap-1.5">
            {ADMIN_PERMISSIONS.map(p => (
              <span key={p.id} className={`rounded-md px-2 py-1 text-[11px] font-medium ${perms.includes(p.id) ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-50 text-gray-400'}`}>
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
