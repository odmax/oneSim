'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderDependencies } from '@/lib/actions/provider-lifecycle'

interface Props {
  providerId: string
  providerName: string
  providerStatus: string
  isSuperAdmin: boolean
  isDefaultFallback: boolean
}

export function ProviderLifecycleActions({ providerId, providerName, providerStatus, isSuperAdmin, isDefaultFallback }: Props) {
  const router = useRouter()
  const [archiveModal, setArchiveModal] = useState<{ deps: ProviderDependencies } | null>(null)
  const [resetModal, setResetModal] = useState(false)
  const [deleteModal, setDeleteModal] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleCheckArchive() {
    setLoading('archive')
    setError(null)
    try {
      const { getProviderDependencies } = await import('@/lib/actions/provider-lifecycle')
      const deps = await getProviderDependencies(providerId)
      setArchiveModal({ deps })
    } catch (e: any) {
      setError(e.message || 'Failed to check dependencies')
    }
    setLoading(null)
  }

  async function handleConfirmArchive() {
    setLoading('archive-confirm')
    setError(null)
    try {
      const { archiveProvider } = await import('@/lib/actions/provider-lifecycle')
      const result = await archiveProvider(providerId)
      if (result.success) {
        router.refresh()
      } else {
        setError(result.error || 'Archive failed')
      }
    } catch (e: any) {
      setError(e.message || 'Failed to archive')
    }
    setLoading(null)
    setArchiveModal(null)
  }

  async function handleReset() {
    setLoading('reset')
    setError(null)
    try {
      const { resetProviderConfiguration } = await import('@/lib/actions/provider-lifecycle')
      const result = await resetProviderConfiguration(providerId)
      if (result.success) {
        router.refresh()
      } else {
        setError(result.error || 'Reset failed')
      }
    } catch (e: any) {
      setError(e.message || 'Failed to reset')
    }
    setLoading(null)
    setResetModal(false)
  }

  async function handleHardDelete() {
    setLoading('delete')
    setError(null)
    try {
      const { hardDeleteProvider } = await import('@/lib/actions/provider-lifecycle')
      const result = await hardDeleteProvider(providerId)
      if (result.success) {
        router.push('/admin/providers?success=Provider+deleted')
      } else {
        setError(result.error || 'Delete failed')
        if ((result as any).dependencies) {
          setDeleteModal(false)
        }
      }
    } catch (e: any) {
      setError(e.message || 'Failed to delete')
    }
    setLoading(null)
    setDeleteModal(false)
  }

  const isArchived = providerStatus === 'ARCHIVED'

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Lifecycle Management</h3>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleCheckArchive}
          disabled={loading === 'archive' || isArchived}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            isArchived
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-amber-600 text-white hover:bg-amber-700'
          }`}
        >
          {loading === 'archive' ? 'Checking...' : isArchived ? 'Archived' : 'Archive Provider'}
        </button>

        <button
          onClick={() => setResetModal(true)}
          disabled={loading === 'reset'}
          className="rounded-lg border border-orange-300 px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50"
        >
          Reset Configuration
        </button>

        {isSuperAdmin && (
          <button
            onClick={() => setDeleteModal(true)}
            disabled={loading === 'delete'}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {isSuperAdmin ? 'Hard Delete (SUPER_ADMIN)' : 'Hard Delete'}
          </button>
        )}
      </div>

      {isDefaultFallback && (
        <p className="mt-3 text-xs text-amber-600">
          This provider is the default fallback. Archiving will clear the fallback flag.
        </p>
      )}

      {/* Archive confirmation modal */}
      {archiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-lg font-semibold text-gray-900">Archive Provider</h4>
            <p className="mt-2 text-sm text-gray-600">
              This will set <strong>{providerName}</strong> to <strong>ARCHIVED</strong> status. The provider will be removed from routing and active selections. All historical records will be preserved.
            </p>

            {archiveModal.deps.hasDependencies && (
              <div className="mt-4 rounded-lg bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-800">Linked records that will be preserved:</p>
                <ul className="mt-2 space-y-1 text-sm text-amber-700">
                  {archiveModal.deps.packages > 0 && <li>• {archiveModal.deps.packages} package(s)</li>}
                  {archiveModal.deps.purchases > 0 && <li>• {archiveModal.deps.purchases} purchase(s)</li>}
                  {archiveModal.deps.esims > 0 && <li>• {archiveModal.deps.esims} eSIM(s)</li>}
                  {archiveModal.deps.pricingRules > 0 && <li>• {archiveModal.deps.pricingRules} pricing rule(s)</li>}
                </ul>
              </div>
            )}

            {!archiveModal.deps.hasDependencies && (
              <p className="mt-4 text-sm text-gray-500">No linked records found. Safe to archive.</p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setArchiveModal(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmArchive}
                disabled={loading === 'archive-confirm'}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {loading === 'archive-confirm' ? 'Archiving...' : 'Confirm Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation modal */}
      {resetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-lg font-semibold text-gray-900">Reset Configuration</h4>
            <p className="mt-2 text-sm text-gray-600">
              This will clear all authentication tokens, cached configuration, sync state, and health metrics for <strong>{providerName}</strong>. The provider record will be preserved.
            </p>
            <p className="mt-2 text-sm text-orange-600 font-medium">
              After reset, you will need to re-authenticate and re-sync plans.
            </p>

            <div className="mt-4 rounded-lg bg-orange-50 p-4 text-sm text-orange-700">
              <p className="font-medium">This will clear:</p>
              <ul className="mt-1 list-disc pl-4 space-y-1">
                <li>API token and base URL</li>
                <li>Encrypted credentials (password, account info)</li>
                <li>Health metrics and error counts</li>
                <li>Sync state and timestamps</li>
              </ul>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setResetModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={loading === 'reset'}
                className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {loading === 'reset' ? 'Resetting...' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hard delete confirmation modal */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-lg font-semibold text-red-700">Hard Delete Provider</h4>
            <p className="mt-2 text-sm text-gray-600">
              This will <strong className="text-red-700">permanently delete</strong> the provider record for <strong>{providerName}</strong>. This action cannot be undone.
            </p>

            {!isSuperAdmin && (
              <p className="mt-2 text-sm text-red-600 font-medium">
                Only SUPER_ADMIN can hard-delete providers.
              </p>
            )}

            <div className="mt-4 rounded-lg bg-red-50 p-4 text-sm text-red-700">
              <p className="font-medium">Requirements:</p>
              <ul className="mt-1 list-disc pl-4 space-y-1">
                <li>SUPER_ADMIN role required</li>
                <li>No linked packages, purchases, eSIMs, or pricing rules</li>
                <li>Archive the provider instead if it has historical records</li>
              </ul>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setDeleteModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleHardDelete}
                disabled={loading === 'delete' || !isSuperAdmin}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {loading === 'delete' ? 'Deleting...' : 'Permanently Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
