import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { loadAdminAccess } from '@/lib/auth/permissions'
import LoginForm from './login/login-form'

export default async function HomePage() {
  const session = await getServerSession(authOptions)

  if (session) {
    if (session.user.role === 'INTERNAL_ADMIN') {
      // DB-backed guard: a stale session token claiming INTERNAL_ADMIN whose
      // InternalAdmin row is missing or deactivated must NOT enter the /admin
      // layout (which would bounce it back here). Terminate at the external
      // access-denied route instead.
      const access = session.user.id ? await loadAdminAccess(session.user.id) : null
      if (!access) redirect('/admin-access-denied')
      redirect('/admin/dashboard')
    } else if (session.user.role === 'BUSINESS_USER') {
      redirect('/business/dashboard')
    }
  }

  return <LoginForm />
}
