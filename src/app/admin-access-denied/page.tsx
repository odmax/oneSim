import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import AdminAccessDeniedSignOut from './sign-out-button'

/**
 * External access-denied route for stale INTERNAL_ADMIN sessions whose
 * InternalAdmin row is missing or deactivated. This page lives OUTSIDE the
 * /admin layout so a session with no active admin access can terminate here
 * instead of looping AdminLayout -> /login -> / -> /admin/dashboard.
 *
 * Anonymous users (or sessions that are not admin sessions at all) are sent to
 * /login; only an admin-claimed session reaches the denial screen.
 */
export default async function AdminAccessDeniedPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-2xl">⛔</div>
        <h1 className="text-xl font-bold text-gray-900">Admin Access Unavailable</h1>
        <p className="mt-3 text-sm text-gray-600">
          Your admin account is not active or no longer exists. If you believe this is an error, contact your
          administrator. Sign out and sign back in with an active admin account to continue.
        </p>
        <div className="mt-6">
          <AdminAccessDeniedSignOut />
        </div>
      </div>
    </div>
  )
}