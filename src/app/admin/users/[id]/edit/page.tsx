import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateAdminUser } from '@/lib/actions/admin-users'

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', OPERATIONS_MANAGER: 'Operations Manager',
  PRODUCT_MANAGER: 'Product Manager', SUPPORT_MANAGER: 'Support Manager',
  SUPPORT_AGENT: 'Support Agent', FINANCE_MANAGER: 'Finance Manager',
  ANALYTICS_MANAGER: 'Analytics Manager', READ_ONLY: 'Read Only',
}

export default async function EditAdminUserPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!currentAdmin || currentAdmin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

  const adminUser = await prisma.internalAdmin.findUnique({
    where: { id: params.id },
    include: { user: true },
  })
  if (!adminUser) redirect('/admin/users')

  const currentPermissions = (adminUser.permissions as string[]) || []

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/admin/users" className="text-sm text-gray-500 hover:text-gray-700">← Back to Admin Users</Link>
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Edit Admin User</h2>
        <p className="mt-1 text-sm text-gray-500">{adminUser.user.name} — {adminUser.user.email}</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action={updateAdminUser.bind(null, adminUser.id)} className="space-y-5">
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Role & Status</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Role</label>
                <select name="role" defaultValue={adminUser.role}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="flex items-end pb-2.5">
                <div className="flex items-center gap-3">
                  <input id="isActive" name="isActive" type="checkbox" defaultChecked={adminUser.isActive} className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                  <label htmlFor="isActive" className="text-sm text-gray-700">Active</label>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Permissions</h3>
            <p className="text-xs text-gray-400">Permission management is available on the detail page. Current count: {currentPermissions.length}</p>
            <input type="hidden" name="permissions" value={JSON.stringify(currentPermissions)} />
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Save Changes</button>
            <Link href="/admin/users" className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
