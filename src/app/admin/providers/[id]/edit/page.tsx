import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateProvider } from '@/lib/actions/providers'
import { EditProviderForm } from './EditProviderForm'

export default async function EditProviderPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: params.id } })
  if (!provider) redirect('/admin/providers?error=Provider+not+found')

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href={`/admin/providers/${provider.id}`} className="text-sm text-cyan-600 hover:underline">← Back to Provider</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Edit Provider</h2>
        <p className="text-gray-600">{provider.name} ({provider.code})</p>
      </div>

      {searchParams?.error && (
        <div className="mb-6 max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}

      <div className="max-w-3xl rounded-lg border bg-white p-6 shadow-sm">
        <EditProviderForm provider={provider} />
      </div>
    </div>
  )
}
