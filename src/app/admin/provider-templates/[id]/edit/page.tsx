import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getTemplate } from '@/lib/actions/provider-templates'
import { TemplateForm } from '../../new/TemplateForm'

export default async function EditTemplatePage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const template = await getTemplate(params.id)
  if (!template) redirect('/admin/provider-templates?error=Template+not+found')

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/provider-templates" className="text-sm text-cyan-600 hover:underline">← Back to Templates</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Edit Template: {template.name}</h2>
        <p className="text-gray-600">Modify the reusable provider configuration. Existing providers using this template are not affected.</p>
      </div>

      {searchParams?.error && (
        <div className="mb-6 max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <TemplateForm initial={template} />
      </div>
    </div>
  )
}
