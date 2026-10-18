import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import JobsClient from './JobsClient'

export default async function AdminGate() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_JOBS)
  if (!perm.allowed) redirect('/admin/unauthorized')
  return <JobsClient />
}
