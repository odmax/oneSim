import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import NewInvoiceClient from './NewInvoiceClient'

export default async function AdminGate({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_INVOICES)
  if (!perm.allowed) redirect('/admin/unauthorized')
  return <NewInvoiceClient searchParams={searchParams} />
}
