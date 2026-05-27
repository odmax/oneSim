import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import LoginForm from './login/login-form'

export default async function HomePage() {
  const session = await getServerSession(authOptions)

  if (session) {
    if (session.user.role === 'INTERNAL_ADMIN') {
      redirect('/admin/dashboard')
    } else if (session.user.role === 'BUSINESS_USER') {
      redirect('/business/dashboard')
    }
  }

  return <LoginForm />
}
