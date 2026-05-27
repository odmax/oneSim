import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'

export default async function BusinessPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }
  
  return redirect('/business/dashboard')
}
