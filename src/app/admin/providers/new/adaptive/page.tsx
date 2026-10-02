import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import Link from 'next/link'
import { AdaptiveProviderSetup } from '@/components/admin/providers/AdaptiveProviderSetup'

export default async function AdaptiveNewProviderPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS); if (!perm.allowed) redirect('/admin/unauthorized')

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/providers/new" className="text-sm text-cyan-600 hover:underline">← Back to Simple Setup</Link>
      </div>
      <AdaptiveProviderSetup />
    </div>
  )
}
