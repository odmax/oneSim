import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getTemplates, deleteTemplateAction } from '@/lib/actions/provider-templates'

export default async function ProviderTemplatesPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const templates = await getTemplates()

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/admin/providers" className="text-sm text-cyan-600 hover:underline">← Back to Providers</Link>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">Provider Templates</h2>
          <p className="text-gray-600">Reusable provider configurations. No credentials or tokens are stored in templates.</p>
        </div>
        <Link
          href="/admin/provider-templates/new"
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
        >
          Create Template
        </Link>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
          <p className="text-gray-500">No templates yet. Create one from an existing provider or build from scratch.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map(t => (
            <div key={t.id} className="rounded-lg border bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="mb-2 flex items-start justify-between">
                <h3 className="font-semibold text-gray-900">{t.name}</h3>
                {t.isSystemTemplate && (
                  <span className="inline-flex rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">System</span>
                )}
              </div>
              {t.description && <p className="mb-3 text-sm text-gray-600">{t.description}</p>}
              <div className="mb-4 space-y-1 text-xs text-gray-500">
                <div><span className="font-medium">Connector:</span> {t.connectorType}</div>
                <div><span className="font-medium">Auth:</span> {t.authType}</div>
                <div><span className="font-medium">Token:</span> {t.tokenPlacement}</div>
                {t.defaultBaseUrl && <div className="truncate"><span className="font-medium">Base URL:</span> {t.defaultBaseUrl}</div>}
              </div>
              <div className="flex gap-2">
                <Link
                  href={`/admin/provider-templates/${t.id}/edit`}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Edit
                </Link>
                <form action={deleteTemplateAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <input type="hidden" name="name" value={t.name} />
                  <button type="submit" className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                    Delete
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
