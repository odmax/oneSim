import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isSuperAdminRole, effectivePermissions, checkPermission, Permissions } from '@/lib/auth/permissions'
import AdminUserEditForm from './AdminUserEditForm'

export default async function EditAdminUserPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_USERS); if (!perm.allowed) redirect('/admin/unauthorized')
  const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!currentAdmin || !isSuperAdminRole(currentAdmin.role)) redirect('/admin?error=unauthorized')

  const adminUser = await prisma.internalAdmin.findUnique({
    where: { id: params.id },
    include: { user: true },
  })
  if (!adminUser) redirect('/admin/users')

  // An EXPLICIT stored array (including an empty []) is preserved verbatim so a
  // deliberate "no permissions" stays effective; role defaults apply ONLY to
  // legacy null/undefined stored values.
  const initialPermissions = effectivePermissions(String(adminUser.role), adminUser.permissions)

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/admin/users" className="text-sm text-gray-500 hover:text-gray-700">← Back to Admin Users</Link>
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Edit Admin User</h2>
        <p className="mt-1 text-sm text-gray-500">{adminUser.user.name} — {adminUser.user.email}</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <AdminUserEditForm
        adminId={adminUser.id}
        name={adminUser.user.name}
        email={adminUser.user.email}
        initialRole={adminUser.role}
        initialActive={adminUser.isActive}
        initialPermissions={initialPermissions}
      />
    </div>
  )
}