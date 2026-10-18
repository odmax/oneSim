import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import NewAdminUserClient from './NewAdminUserClient'

export default async function AdminGate({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_USERS)
  if (!perm.allowed) redirect('/admin/unauthorized')
  return <NewAdminUserClient searchParams={searchParams} />
}
