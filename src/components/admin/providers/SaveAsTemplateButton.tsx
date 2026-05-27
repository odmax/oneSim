'use client'

import { useState } from 'react'
import { saveProviderAsTemplate } from '@/lib/actions/provider-templates'

export function SaveAsTemplateButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(`${providerName} Template`)
  const [description, setDescription] = useState(`Template created from ${providerName}`)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function handleSave(formData: FormData) {
    const result = await saveProviderAsTemplate(providerId, formData)
    if (result.success) {
      setMessage({ type: 'success', text: 'Template saved!' })
      setTimeout(() => { setOpen(false); setMessage(null) }, 1500)
    } else {
      setMessage({ type: 'error', text: result.error || 'Failed to save template' })
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
      >
        Save as Template
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Save as Template</h3>
            <p className="mb-4 text-sm text-gray-600">Create a reusable template from {providerName}. No credentials or tokens will be copied.</p>

            {message && (
              <div className={`mb-4 rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                {message.text}
              </div>
            )}

            <form action={handleSave} className="space-y-4">
              <input type="hidden" name="providerId" value={providerId} />
              <div>
                <label className="block text-sm font-medium text-gray-700">Template Name</label>
                <input
                  type="text" name="name" required
                  value={name} onChange={e => setName(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Description</label>
                <textarea
                  name="description" rows={2}
                  value={description} onChange={e => setDescription(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex gap-3">
                <button type="submit" className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
                  Save Template
                </button>
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
