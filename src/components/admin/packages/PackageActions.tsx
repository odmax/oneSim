'use client'

import Link from 'next/link'
import { hidePackageFromClients, movePackageToProviderPlan, togglePackageActivation } from '@/lib/actions/markup'
import { convertToCatalogProduct } from '@/lib/actions/catalog'
import { deletePackageAction } from '@/lib/actions/package'
import { ConfirmForm } from '@/components/admin/providers/ConfirmForm'

interface PackageActionsProps {
  pkg: {
    id: string
    source: string
    isActive: boolean
    hiddenFromCatalog?: boolean | null
    archivedAt?: string | null
    displayName?: string | null
    name: string
    priceUSD: any
    localPrice?: any
    costPriceUSD?: any
    providerName?: string | null
    providerPlanId?: string | null
    sku?: string | null
    packageCode?: string | null
    _count?: { purchases?: number; topUpRecords?: number }
  }
  isImported?: boolean
}

/**
 * Shared package action buttons determined by package state, not provider type.
 * State matrix:
 *   PROVIDER_PLAN → Configure & Publish, Quick Add, Delete
 *   CATALOG/MANUAL + active+visible → Edit, Archive, Hide from Catalog, Delete
 *   CATALOG/MANUAL + active+hidden  → Edit, Archive, Show in Catalog, Delete
 *   CATALOG/MANUAL + archived       → Edit, Unarchive, Delete
 *   CATALOG/MANUAL + inactive       → Edit, Activate, Delete
 */
export default function PackageActions({ pkg, isImported = false }: PackageActionsProps) {
  const isProviderPlan = pkg.source === 'PROVIDER_PLAN'
  const isArchived = !!pkg.hiddenFromCatalog || !!pkg.archivedAt
  const isHidden = !pkg.isActive && !isArchived
  const hasDependents = (pkg._count?.purchases ?? 0) > 0 || (pkg._count?.topUpRecords ?? 0) > 0

  const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
  const sellingPrice = parseFloat(pkg.priceUSD.toString())
  const priceValue = sellingPrice > 0 ? sellingPrice : (costPrice > 0 ? (costPrice * 1.2).toFixed(2) : '1.00')

  return (
    <div className="flex flex-wrap gap-2">
      {isProviderPlan ? (
        <>
          <Link href={`/admin/packages/${pkg.id}/edit`}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
            {pkg.displayName ? 'Edit & Publish' : 'Configure & Publish'}
          </Link>
          <form action={convertToCatalogProduct.bind(null, pkg.id)}>
            <input type="hidden" name="priceUSD" value={String(priceValue)} />
            <input type="hidden" name="localPrice" value={String(priceValue)} />
            <input type="hidden" name="isActive" value="off" />
            <button type="submit" className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Quick Add</button>
          </form>
          <DeleteButton hasDependents={hasDependents} pkgId={pkg.id} />
        </>
      ) : (
        <>
          <Link href={`/admin/packages/${pkg.id}/edit`}
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50">
            Edit
          </Link>

          {isArchived ? (
            <form action={togglePackageActivation.bind(null, pkg.id)}>
              <input type="hidden" name="isActive" value="on" />
              <button type="submit" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-100">Unarchive</button>
            </form>
          ) : isHidden ? (
            <>
              <form action={togglePackageActivation.bind(null, pkg.id)}>
                <input type="hidden" name="isActive" value="on" />
                <button type="submit" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-100">Activate</button>
              </form>
              <ConfirmForm action={hidePackageFromClients.bind(null, pkg.id)}
                message="Hide this package from business clients? Existing orders/eSIMs will not be affected.">
                <button type="submit" className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-600 hover:bg-amber-100">Archive</button>
              </ConfirmForm>
            </>
          ) : (
            <>
              <ConfirmForm action={hidePackageFromClients.bind(null, pkg.id)}
                message="Hide this package from business clients? Existing orders/eSIMs will not be affected.">
                <button type="submit" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100">Hide</button>
              </ConfirmForm>
            </>
          )}

          {isImported && pkg.source === 'CATALOG_PRODUCT' && !pkg.isActive && !isArchived && (
            <ConfirmForm action={movePackageToProviderPlan.bind(null, pkg.id)}
              message="Move this package back to Provider Plans? It will no longer appear under Catalog Products. Provider mapping will be preserved.">
              <button type="submit" className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">Revert</button>
            </ConfirmForm>
          )}

          <DeleteButton hasDependents={hasDependents} pkgId={pkg.id} />
        </>
      )}
    </div>
  )
}

function DeleteButton({ hasDependents, pkgId }: { hasDependents: boolean; pkgId: string }) {
  const label = hasDependents ? 'Hide from Catalog' : 'Delete'
  const msg = hasDependents
    ? 'This package has purchased eSIMs. It will be hidden from future sales, but existing eSIMs, orders, and reports will remain.'
    : 'This package has no purchases and will be permanently deleted.'

  return (
    <form action={deletePackageAction} onSubmit={e => { if (!confirm(msg)) e.preventDefault() }}>
      <input type="hidden" name="id" value={pkgId} />
      <button type="submit" className={`rounded-lg px-3 py-2 text-sm font-medium ${hasDependents ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}>
        {label}
      </button>
    </form>
  )
}
