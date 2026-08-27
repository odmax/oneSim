'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { validatePricing } from '@/lib/pricing/pricing-engine'
import { revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import {
  resolveBackingProviders,
  type BackingProviderPackageLike,
} from '@/lib/services/custom-package/custom-package'

export type CreateCustomPackageResult =
  | { success: true; esimPackageId: string; providerPackageIds: string[] }
  | { success: false; error: string }

const MAX_BACKINGS = 12

async function requireAdmin(): Promise<string> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')
  return session.user.id
}

/**
 * Create a OneSIM custom retail package fulfilled by one or more existing
 * ProviderPackage backends, then publish immediately through the canonical
 * catalog pipeline.
 *
 * Provider-neutral: no provider-name branch. All provider/ProviderPackage ids
 * are re-read server-side; browser-provided values are never trusted.
 *
 * Provider-side package creation is NOT invoked (no connector is proven to
 * support creating a new provider catalog offering).
 */
export async function createCustomPackage(formData: FormData): Promise<CreateCustomPackageResult> {
  const userId = await requireAdmin()

  const name = (formData.get('name') as string || '').trim()
  const displayName = (formData.get('displayName') as string || name).trim() || name
  const description = (formData.get('description') as string || '').trim()
  const dataGB = Number(formData.get('dataGB') || 0)
  const validityDays = Number(formData.get('validityDays') || 0)
  const sellingPrice = Number(formData.get('sellingPrice') || 0)
  const currency = (formData.get('currency') as string || 'USD').toUpperCase().slice(0, 3)
  const countriesRaw = (formData.get('countries') as string || '').split(',').map(c => c.trim()).filter(Boolean)
  const policy = (formData.get('compatibilityPolicy') as string || 'AT_LEAST') as 'EXACT' | 'AT_LEAST'
  const productType = ((formData.get('productType') as string || 'NEW_ESIM').toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'NEW_ESIM') as 'NEW_ESIM' | 'TOP_UP' | 'BOTH'
  const allowFailover = (formData.get('allowFailover') as string) === 'true'

  // Provider/package/priority/enabled are parallel arrays established by the UI.
  const backingIds = (formData.getAll('providerPackageIds') as string[]).slice(0, MAX_BACKINGS)
  const providerIds = (formData.getAll('providerIds') as string[]).slice(0, MAX_BACKINGS)
  const priorities = (formData.getAll('priorities') as string[]).slice(0, MAX_BACKINGS).map(Number)
  const enabledFlags = (formData.getAll('enabledFlags') as string[]).slice(0, MAX_BACKINGS).map(v => v === 'true')

  if (!name) return { success: false, error: 'Package name is required' }
  if (!Number.isFinite(dataGB) || dataGB <= 0) return { success: false, error: 'Data allowance must be > 0' }
  if (!Number.isFinite(validityDays) || validityDays <= 0) return { success: false, error: 'Validity must be > 0' }
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return { success: false, error: 'Selling price must be > 0' }
  if (policy !== 'EXACT' && policy !== 'AT_LEAST') return { success: false, error: 'Invalid compatibility policy' }

  // Build backing rows with explicit priorities + enabled state (server-side).
  const rows = backingIds.map((pid, i) => ({
    providerPackageId: pid,
    providerId: providerIds[i] || null,
    priority: Number.isFinite(priorities[i]) ? priorities[i] : NaN,
    enabled: enabledFlags[i] !== undefined ? enabledFlags[i] : true,
  }))
  const enabledRows = rows.filter(r => r.enabled && r.providerPackageId)

  // ---- Server-side priority/backing invariants ----
  if (enabledRows.length === 0) return { success: false, error: 'At least one enabled backing ProviderPackage is required' }
  if (enabledRows.length > MAX_BACKINGS) return { success: false, error: `Too many backings (max ${MAX_BACKINGS})` }
  if (!enabledRows.some(r => r.priority === 1)) return { success: false, error: 'Priority 1 (primary provider) is required' }
  const prioritiesSet = enabledRows.map(r => r.priority)
  if (prioritiesSet.some(p => !Number.isFinite(p) || p < 1)) return { success: false, error: 'Priorities must be >= 1' }
  if (new Set(prioritiesSet).size !== prioritiesSet.length) return { success: false, error: 'Priorities must be unique' }

  const packageIdSet = enabledRows.map(r => r.providerPackageId)
  if (new Set(packageIdSet).size !== packageIdSet.length) return { success: false, error: 'The same ProviderPackage cannot be selected twice' }

  // Server-side pricing validation (canonical rules). The retail package has no
  // single provider cost (provider costs live on the backings), so validate the
  // selling price is a positive finite value.
  const pricingValidation = validatePricing(0, sellingPrice)
  if (!pricingValidation.valid) {
    return { success: false, error: pricingValidation.errors?.join('; ') || 'Invalid pricing' }
  }

  const orderedIds = [...enabledRows].sort((a, b) => a.priority - b.priority).map(r => r.providerPackageId)

  // Re-read backing ProviderPackages server-side (never trust the browser).
  const backings = await prisma.providerPackage.findMany({
    where: { id: { in: orderedIds } },
    include: { provider: { select: { id: true, status: true, enabledCapabilities: true } } },
  })
  if (backings.length === 0) return { success: false, error: 'No backing ProviderPackages found' }

  const candidates: BackingProviderPackageLike[] = backings.map(b => ({
    id: b.id,
    providerId: b.providerId,
    dataGB: b.dataGB,
    validityDays: b.validityDays,
    country: b.country,
    region: b.region,
    provider: { id: b.provider.id, status: b.provider.status, enabledCapabilities: b.provider.enabledCapabilities },
    configurationStatus: b.configurationStatus,
    publishStatus: b.publishStatus,
    sellingPrice: b.sellingPrice,
    costPrice: b.costPrice,
  }))

  const resolved = resolveBackingProviders({ dataGB, validityDays, countries: countriesRaw, policy, candidates })
  const usable = resolved.filter(r => r.compatible && r.purchaseReady)
  if (usable.length === 0) {
    return { success: false, error: 'None of the selected ProviderPackages can fulfill this custom package (compatibility/purchase-readiness failed)' }
  }

  // Recompute priority order based on the resolved usable set, preserving the
  // admin's priority ordering.
  const priorityById = new Map(enabledRows.map(r => [r.providerPackageId, r.priority]))
  const usableIds = new Set(usable.map(u => u.providerPackageId))
  const ordered = usable
    .filter(u => usableIds.has(u.providerPackageId))
    .sort((a, b) => (priorityById.get(a.providerPackageId) ?? 999) - (priorityById.get(b.providerPackageId) ?? 999))

  // ---- ATOMIC creation: package + priority-ordered bindings in ONE transaction.
  // If any binding creation fails, the whole thing rolls back — never a
  // half-created custom package. ----
  const esimPackage = await prisma.$transaction(async (tx) => {
    const created = await tx.eSIMPackage.create({
      data: {
        name,
        displayName,
        description: description || null,
        customerDescription: description || null,
        dataGB,
        validityDays,
        priceUSD: sellingPrice,
        localPrice: sellingPrice,
        currency,
        isActive: true,
        source: 'CATALOG_PRODUCT',
        productType,
        hiddenFromCatalog: false,
        archivedAt: null,
        // Custom packages are not bound to a single ProviderPackage — they use bindings.
        providerPackageId: null,
        // Persist backing ids + policy + failover as safe metadata for reconciliation.
        providerRawData: {
          customPackage: { policy, backingCount: ordered.length, allowFailover },
          backingProviderPackageIds: ordered.map(u => u.providerPackageId),
        },
      },
    })

    for (const [idx, b] of ordered.entries()) {
      await tx.eSIMPackageProviderBinding.create({
        data: {
          esimPackageId: created.id,
          providerPackageId: b.providerPackageId,
          priority: idx + 1,
          isActive: true,
        },
      })
    }

    return created
  })

  await prisma.auditLog.create({
    data: {
      userId,
      action: 'CUSTOM_PACKAGE_CREATED',
      entity: 'ESIMPackage',
      entityId: esimPackage.id,
      details: `Created custom retail package ${name} (${dataGB}GB/${validityDays}d, $${sellingPrice}) with ${ordered.length} backing ProviderPackages, failover=${allowFailover ? 'on' : 'off'}`,
    },
  }).catch(() => {})

  await prisma.auditLog.create({
    data: {
      userId,
      action: 'CUSTOM_PACKAGE_PUBLISHED',
      entity: 'ESIMPackage',
      entityId: esimPackage.id,
      details: `Published custom package ${name} into retail catalog`,
    },
  }).catch(() => {})

  // Immediate publish through the canonical catalog pipeline. The retail product
  // is created active/visible; revalidate the canonical catalog routes so it
  // appears in client + provider catalogs.
  await revalidateCatalogRoutes()
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')

  redirect(`/admin/packages?tab=catalog&success=${encodeURIComponent(`Custom package "${name}" created and published`)}`)
}
