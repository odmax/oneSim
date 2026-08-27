'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import { createCustomPackageWithMode } from '@/lib/services/custom-package/create-custom-package-service'
import type { CustomPackageCreationMode, CustomPackageCreateRequest } from '@/lib/services/custom-package/types'

export type CreateCustomPackageResult =
  | { success: true; esimPackageId: string; providerPackageIds: string[] }
  | { success: false; error: string; partialFailure?: boolean; providerReference?: string; requiresReconciliation?: boolean; operationId?: string; category?: string }

const MAX_BACKINGS = 12

async function requireAdmin(): Promise<string> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')
  return session.user.id
}

/**
 * Create a OneSIM custom retail package.
 *
 * mode=EXISTING_BACKINGS — assemble from existing ProviderPackages (atomic local
 * transaction, no upstream call).
 *
 * mode=UPSTREAM_CREATE — create a new upstream package/template with a provider
 * that supports authoring, then persist ProviderPackage + ESIMPackage + binding.
 *
 * Both modes: admin authz enforced here, provider eligibility re-validated inside
 * the canonical service (never trust browser values).
 */
export async function createCustomPackage(formData: FormData): Promise<CreateCustomPackageResult> {
  const userId = await requireAdmin()

  const modeRaw = (formData.get('mode') as string || 'EXISTING_BACKINGS').toUpperCase()
  const mode: CustomPackageCreationMode = modeRaw === 'UPSTREAM_CREATE' ? 'UPSTREAM_CREATE' : 'EXISTING_BACKINGS'

  const request: CustomPackageCreateRequest = {
    mode,
    name: (formData.get('name') as string || '').trim(),
    displayName: (formData.get('displayName') as string || '').trim(),
    description: (formData.get('description') as string || '').trim(),
    dataGB: Number(formData.get('dataGB') || 0),
    validityDays: Number(formData.get('validityDays') || 0),
    countries: (formData.get('countries') as string || '').split(',').map(c => c.trim()).filter(Boolean),
    productType: ((formData.get('productType') as string || 'NEW_ESIM').toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'NEW_ESIM') as 'NEW_ESIM' | 'TOP_UP' | 'BOTH',
    currency: (formData.get('currency') as string || 'USD').toUpperCase().slice(0, 3),
    sellingPrice: Number(formData.get('sellingPrice') || 0),
  }

  if (mode === 'UPSTREAM_CREATE') {
    request.providerId = (formData.get('providerId') as string || '').trim()
    request.upstreamConfirmed = formData.get('upstreamConfirmed') === 'true'
    request.upstreamIdempotencyKey = (formData.get('upstreamIdempotencyKey') as string || '').trim() || undefined
    const providerValuesRaw = formData.get('providerValues')
    if (providerValuesRaw) {
      try {
        const parsed = JSON.parse(providerValuesRaw as string)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          request.providerValues = parsed as Record<string, unknown>
        }
      } catch {
        // malformed providerValues → ignore; validation elsewhere requires the
        // documented provider-specific fields.
      }
    }
  } else {
    request.compatibilityPolicy = (formData.get('compatibilityPolicy') as string || 'AT_LEAST') as 'EXACT' | 'AT_LEAST'
    request.allowFailover = (formData.get('allowFailover') as string) === 'true'
    const backingIds = (formData.getAll('providerPackageIds') as string[]).slice(0, MAX_BACKINGS)
    const providerIds = (formData.getAll('providerIds') as string[]).slice(0, MAX_BACKINGS)
    const priorities = (formData.getAll('priorities') as string[]).slice(0, MAX_BACKINGS).map(Number)
    const enabledFlags = (formData.getAll('enabledFlags') as string[]).slice(0, MAX_BACKINGS).map(v => v === 'true')
    request.backings = backingIds.map((pid, i) => ({
      providerPackageId: pid,
      providerId: providerIds[i] || null,
      priority: Number.isFinite(priorities[i]) ? priorities[i] : NaN,
      enabled: enabledFlags[i] !== undefined ? enabledFlags[i] : true,
    }))
  }

  const result = await createCustomPackageWithMode(request, userId)

  if (!result.success) {
    // Audit Mode B non-ok outcomes safely (partial / ambiguous / already-exists).
    if (mode === 'UPSTREAM_CREATE') {
      const outcomeKind =
        result.partialFailure ? 'PARTIAL_FAILURE'
          : result.requiresReconciliation ? 'REQUIRES_RECONCILIATION'
            : 'FAILED'
      await prisma.auditLog.create({
        data: {
          userId,
          action: outcomeKind === 'PARTIAL_FAILURE'
            ? 'CUSTOM_PACKAGE_UPSTREAM_PARTIAL'
            : outcomeKind === 'REQUIRES_RECONCILIATION'
              ? 'CUSTOM_PACKAGE_UPSTREAM_AMBIGUOUS'
              : 'CUSTOM_PACKAGE_UPSTREAM_FAILED',
          entity: 'ESIMPackage',
          entityId: result.esimPackageId || undefined,
          details: JSON.stringify({
            mode: 'UPSTREAM_CREATE',
            adminUserId: userId,
            operationId: result.operationId,
            idempotencyKeyPrefix: (request.upstreamIdempotencyKey || '').slice(0, 12),
            providerId: result.providerId,
            providerCode: result.providerCode,
            upstreamProviderPlanId: result.providerPackageId,
            providerReference: result.providerReference,
            category: result.category,
            name: request.name,
            requestedSku: String(request.providerValues?.sku || ''),
            result: outcomeKind,
            error: result.error,
            timestamp: new Date().toISOString(),
          }),
        },
      }).catch(() => {})
    }
    return {
      success: false,
      error: result.error || 'Creation failed',
      partialFailure: result.partialFailure,
      providerReference: result.providerReference,
      requiresReconciliation: result.requiresReconciliation,
      operationId: result.operationId,
      category: result.category,
    }
  }

  // Audit + revalidation (audit handling is shared here so both modes record it).
  await auditCreation(result, userId, mode, request)

  await revalidateCatalogRoutes()
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')

  redirect(`/admin/packages?tab=catalog&success=${encodeURIComponent(`Custom package "${request.name}" created`)}`)
}

async function auditCreation(result: { esimPackageId?: string; providerId?: string; providerCode?: string; providerPackageId?: string; localProviderPackageId?: string; providerPackageIds?: string[]; operationId?: string; upstreamIdempotencyKey?: string; providerReference?: string }, userId: string, mode: string, request: CustomPackageCreateRequest): Promise<void> {
  const ts = new Date().toISOString()
  if (mode === 'UPSTREAM_CREATE') {
    await prisma.auditLog.create({
      data: {
        userId,
        action: 'CUSTOM_PACKAGE_UPSTREAM_CREATED',
        entity: 'ESIMPackage',
        entityId: result.esimPackageId,
        details: JSON.stringify({
          mode: 'UPSTREAM_CREATE',
          adminUserId: userId,
          operationId: result.operationId,
          idempotencyKeyPrefix: (result.upstreamIdempotencyKey || '').slice(0, 12),
          providerId: result.providerId,
          providerCode: result.providerCode,
          upstreamProviderPlanId: result.providerPackageId,
          upstreamReference: result.providerReference,
          localProviderPackageId: result.localProviderPackageId,
          esimPackageId: result.esimPackageId,
          name: request.name,
          dataGB: request.dataGB,
          validityDays: request.validityDays,
          currency: request.currency,
          sellingPrice: request.sellingPrice,
          result: 'SUCCESS',
          timestamp: ts,
        }),
      },
    }).catch(() => {})
    return
  }

  await prisma.auditLog.create({
    data: {
      userId,
      action: 'CUSTOM_PACKAGE_CREATED',
      entity: 'ESIMPackage',
      entityId: result.esimPackageId,
      details: `Created custom retail package "${request.name}" (${request.dataGB}GB/${request.validityDays}d, ${request.currency} ${request.sellingPrice}) with ${(result.providerPackageIds || []).length} backing ProviderPackages`,
    },
  }).catch(() => {})
}