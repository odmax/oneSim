import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { TemplateForm } from './TemplateForm'

export default async function NewTemplatePage({ searchParams }: { searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/provider-templates" className="text-sm text-cyan-600 hover:underline">← Back to Templates</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Create Provider Template</h2>
        <p className="text-gray-600">Define a reusable provider configuration. No credentials or tokens are stored.</p>
      </div>

      {searchParams?.error && (
        <div className="mb-6 max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <TemplateForm />
      </div>
    </div>
  )
}
