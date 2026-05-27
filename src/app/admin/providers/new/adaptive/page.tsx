import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { AdaptiveProviderSetup } from '@/components/admin/providers/AdaptiveProviderSetup'

export default async function AdaptiveNewProviderPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/providers/new" className="text-sm text-cyan-600 hover:underline">← Back to Simple Setup</Link>
      </div>
      <AdaptiveProviderSetup />
    </div>
  )
}
