import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createProvider } from '@/lib/actions/providers'
import { getTemplates } from '@/lib/actions/provider-templates'
import { NewProviderForm } from './NewProviderForm'

export default async function NewProviderPage({ searchParams }: { searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const templates = await getTemplates()

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/providers" className="text-sm text-cyan-600 hover:underline">← Back to Providers</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Add Provider</h2>
        <p className="text-gray-600">Register a new eSIM provider integration. After creation, you will be guided through authentication setup.</p>
      </div>

      {searchParams?.error && (
        <div className="mb-6 max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <NewProviderForm templates={templates} />
      </div>

      <div className="mt-6 max-w-2xl rounded-lg border border-cyan-200 bg-cyan-50 p-4">
        <p className="text-sm text-cyan-800 font-medium">After creation</p>
        <p className="text-sm text-cyan-700 mt-1">
          You will be taken to the setup wizard to authenticate, test the connection, and sync plans.
        </p>
      </div>

      <div className="mt-4 max-w-2xl rounded-lg border border-purple-200 bg-purple-50 p-4">
        <p className="text-sm text-purple-800 font-medium">Advanced Setup</p>
        <p className="text-sm text-purple-700 mt-1">
          Need to configure paths, field mappings, and endpoints?{' '}
          <Link href="/admin/providers/new/adaptive" className="font-medium text-purple-800 underline hover:text-purple-900">
            Use the Adaptive Provider Setup
          </Link>
          {' '}for full control over every setting.
        </p>
      </div>
    </div>
  )
}
