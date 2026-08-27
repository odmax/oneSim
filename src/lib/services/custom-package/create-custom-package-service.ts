import { prisma } from '@/lib/prisma'
import { validatePricing } from '@/lib/pricing/pricing-engine'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { getCustomPackageCreationReadiness } from '@/lib/providers/capability-state'
import { resolveBackingProviders, type BackingProviderPackageLike } from './custom-package'
import type { CustomPackageCreateRequest, CustomPackageCreateResult } from './types'

const MAX_BACKINGS = 12

/** Result of idempotent local persistence for an already-created upstream object. */
export type LocalUpstreamPersistResult =
  | { success: true; esimPackageId: string; localProviderPackageId: string }
  | { success: false; error: string }

/**
 * Create a OneSIM custom retail package across BOTH modes:
 *
 * EXISTING_BACKINGS — atomic local DB transaction (package + bindings). No
 * upstream call. Preserves the existing CPB behavior.
 *
 * UPSTREAM_CREATE   — create a NEW upstream package/template with a provider
 * that supports authoring, then persist the ProviderPackage + ESIMPackage +
 * binding. The upstream call CANNOT participate in a Prisma transaction, so a
 * partial failure is handled explicitly (never silently retried).
 *
 * Both modes share: admin authz (checked by the caller/action), server-side
 * re-validation of provider state, and the same OneSIM retail package semantics.
 */
export async function createCustomPackageWithMode(
  request: CustomPackageCreateRequest,
  userId: string,
): Promise<CustomPackageCreateResult> {
  if (request.mode === 'EXISTING_BACKINGS') {
    return createFromExistingBackings(request)
  }
  return createUpstreamPackage(request, userId)
}

/* -------------------------------------------------------------------------- */
/* MODE A — existing backings                                                 */
/* -------------------------------------------------------------------------- */

async function createFromExistingBackings(request: CustomPackageCreateRequest): Promise<CustomPackageCreateResult> {
  const { name, dataGB, validityDays, countries = [], sellingPrice, currency } = request
  const policy = request.compatibilityPolicy || 'AT_LEAST'
  const allowFailover = request.allowFailover ?? false

  if (!name) return { success: false, error: 'Package name is required' }
  if (!Number.isFinite(dataGB) || dataGB <= 0) return { success: false, error: 'Data allowance must be > 0' }
  if (!Number.isFinite(validityDays) || validityDays <= 0) return { success: false, error: 'Validity must be > 0' }
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return { success: false, error: 'Selling price must be > 0' }
  if (policy !== 'EXACT' && policy !== 'AT_LEAST') return { success: false, error: 'Invalid compatibility policy' }

  const backings = request.backings || []
  const enabledRows = backings.filter(b => b.enabled && b.providerPackageId)
  if (enabledRows.length === 0) return { success: false, error: 'At least one enabled backing ProviderPackage is required' }
  if (enabledRows.length > MAX_BACKINGS) return { success: false, error: `Too many backings (max ${MAX_BACKINGS})` }
  if (!enabledRows.some(b => b.priority === 1)) return { success: false, error: 'Priority 1 (primary provider) is required' }
  const priorities = enabledRows.map(b => b.priority)
  if (priorities.some(p => !Number.isFinite(p) || p < 1)) return { success: false, error: 'Priorities must be >= 1' }
  if (new Set(priorities).size !== priorities.length) return { success: false, error: 'Priorities must be unique' }
  const packageIds = enabledRows.map(b => b.providerPackageId)
  if (new Set(packageIds).size !== packageIds.length) return { success: false, error: 'The same ProviderPackage cannot be selected twice' }

  const pricingValidation = validatePricing(0, sellingPrice)
  if (!pricingValidation.valid) {
    return { success: false, error: pricingValidation.errors?.join('; ') || 'Invalid pricing' }
  }

  const orderedIds = [...enabledRows].sort((a, b) => a.priority - b.priority).map(b => b.providerPackageId)

  const backingsDb = await prisma.providerPackage.findMany({
    where: { id: { in: orderedIds } },
    include: { provider: { select: { id: true, status: true, enabledCapabilities: true } } },
  })
  if (backingsDb.length === 0) return { success: false, error: 'No backing ProviderPackages found' }

  const candidates: BackingProviderPackageLike[] = backingsDb.map(b => ({
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
  const resolved = resolveBackingProviders({ dataGB, validityDays, countries, policy, candidates })
  const usable = resolved.filter(r => r.compatible && r.purchaseReady)
  if (usable.length === 0) {
    return { success: false, error: 'None of the selected ProviderPackages can fulfill this custom package (compatibility/purchase-readiness failed)' }
  }

  const priorityById = new Map(enabledRows.map(b => [b.providerPackageId, b.priority]))
  const usableIds = new Set(usable.map(u => u.providerPackageId))
  const ordered = usable
    .filter(u => usableIds.has(u.providerPackageId))
    .sort((a, b) => (priorityById.get(a.providerPackageId) ?? 999) - (priorityById.get(b.providerPackageId) ?? 999))

  const displayName = (request.displayName || name).trim() || name

  const esimPackage = await prisma.$transaction(async (tx) => {
    const created = await tx.eSIMPackage.create({
      data: {
        name,
        displayName,
        description: request.description || null,
        customerDescription: request.description || null,
        dataGB,
        validityDays,
        priceUSD: sellingPrice,
        localPrice: sellingPrice,
        currency,
        isActive: true,
        source: 'CATALOG_PRODUCT',
        productType: request.productType || 'NEW_ESIM',
        hiddenFromCatalog: false,
        archivedAt: null,
        providerPackageId: null,
        providerRawData: {
          customPackage: { mode: 'EXISTING_BACKINGS', policy, backingCount: ordered.length, allowFailover },
          backingProviderPackageIds: ordered.map(u => u.providerPackageId),
        },
      },
    })
    for (const [idx, b] of ordered.entries()) {
      await tx.eSIMPackageProviderBinding.create({
        data: { esimPackageId: created.id, providerPackageId: b.providerPackageId, priority: idx + 1, isActive: true },
      })
    }
    return created
  }).catch((e: any) => {
    // Atomic rollback: the DB transaction aborts so no package/binding is left
    // half-created. Surface a clean failure (not a partial-failure).
    return { __atomicFailure: true as const, message: e?.message || 'Transaction failed' }
  }) as
    | { id: string }
    | { __atomicFailure: true; message: string }

  if ('__atomicFailure' in esimPackage) {
    return { success: false, error: esimPackage.message || 'Custom package creation failed (transaction rolled back)' }
  }

  return {
    success: true,
    esimPackageId: esimPackage.id,
    providerPackageIds: ordered.map(u => u.providerPackageId),
  }
}

/* -------------------------------------------------------------------------- */
/* MODE B — upstream create (durable, idempotent, single-writer)              */
/* -------------------------------------------------------------------------- */

import {
  UPSTREAM_OP_STATUS,
  loadOrCreateUpstreamOperation,
  acquireUpstreamOperationLease,
  transitionUpstreamOperation,
  markUpstreamOperationFailed,
  markUpstreamOperationAmbiguous,
  markUpstreamOperationAlreadyExists,
  isUpstreamOperationLeaseActive,
  isAllowedTransition,
} from './upstream-operation-service'
import { computeUpstreamFingerprint, type FingerprintSource } from './upstream-fingerprint'
import { upstreamCreationGlobalGate } from './upstream-kill-switch'
import { classifyUpstreamCreateError } from '@/lib/providers/connectors/connector-interface'

/**
 * Create a new upstream package/template with a single provider, then persist
 * the resulting ProviderPackage + ESIMPackage + binding.
 *
 * Durable idempotency: an operation row is created BEFORE the upstream call.
 * On any crash/partial failure, recovery resumes local persistence and NEVER
 * blindly re-issues the upstream create.
 *
 * Single-writer: a DB lease (SystemJobLock) + CAS transition to
 * UPSTREAM_IN_PROGRESS ensures exactly one upstream call per idempotency key.
 */
async function createUpstreamPackage(request: CustomPackageCreateRequest, userId: string): Promise<CustomPackageCreateResult> {
  const { name, dataGB, validityDays, sellingPrice, currency, providerId, providerValues } = request

  // 0. Global kill switch (OneSIM exposure flag). Server-side enforced.
  const globalGate = upstreamCreationGlobalGate()
  if (globalGate) return { success: false, error: globalGate, category: 'NOT_ENTITLED' }

  // 1. Basic input validation.
  if (!name) return { success: false, error: 'Package name is required', category: 'VALIDATION' }
  if (!Number.isFinite(dataGB) || dataGB <= 0) return { success: false, error: 'Data allowance must be > 0', category: 'VALIDATION' }
  if (!Number.isFinite(validityDays) || validityDays <= 0) return { success: false, error: 'Validity must be > 0', category: 'VALIDATION' }
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return { success: false, error: 'Selling price must be > 0', category: 'VALIDATION' }
  if (!providerId) return { success: false, error: 'A provider is required for upstream creation', category: 'VALIDATION' }
  if (request.upstreamConfirmed !== true) return { success: false, error: 'Upstream creation requires explicit confirmation', category: 'VALIDATION' }

  // Idempotency key is required and must look like a CPB upstream key.
  const idempotencyKey = (request.upstreamIdempotencyKey || '').trim()
  if (!/^cpb_upstream_[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
    return { success: false, error: 'A valid upstream idempotency key is required', category: 'VALIDATION' }
  }

  const pricingValidation = validatePricing(0, sellingPrice)
  if (!pricingValidation.valid) {
    return { success: false, error: pricingValidation.errors?.join('; ') || 'Invalid pricing', category: 'VALIDATION' }
  }

  // 2. Re-resolve provider + capability/readiness server-side (never trust form).
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found', category: 'VALIDATION' }
  const readiness = await getCustomPackageCreationReadiness(providerId)
  if (!readiness.ready) {
    return { success: false, error: `Provider is not enabled for upstream creation (${readiness.reason || 'not-ready'})`, category: 'NOT_ENTITLED' }
  }
  const connector = await buildConnectorFromProvider(providerId).catch(() => null)
  if (!connector || typeof connector.createCustomPackage !== 'function' || typeof connector.getCustomPackageDefinition !== 'function') {
    return { success: false, error: 'Provider connector does not support upstream package creation', category: 'NOT_ENTITLED' }
  }

  // 3. Normalize the upstream-relevant provider values (never trust arbitrary keys).
  const sku = String(providerValues?.sku || '').trim()
  if (!sku) return { success: false, error: 'A provider SKU is required', category: 'VALIDATION' }

  // Build a SAFE normalized provider field set derived from the connector's
  // declared definition + documented Choice fields. Anything else submitted is
  // dropped (never passed through to the provider).
  const pv = (providerValues || {}) as Record<string, unknown>
  const pool = pv.pool != null ? Number(pv.pool) : null
  const bundleName = String(pv.bundle_name || name).trim()
  const roamingProfileId = pv.roaming_profile_id ? String(pv.roaming_profile_id) : undefined
  const servingNetworks = pv.serving_networks ? String(pv.serving_networks) : undefined
  const occurrences = pv.rate_group_occurrences != null ? Number(pv.rate_group_occurrences) : undefined
  const allowThrottle = pv.allow_throttle != null ? Boolean(pv.allow_throttle) : undefined
  const allowTethering = pv.allow_tethering != null ? Boolean(pv.allow_tethering) : undefined

  // 4. Fingerprint — covers mutation-critical fields only.
  const fingerprint = computeUpstreamFingerprint({
    providerId,
    sku,
    bundleName,
    dataGB,
    validityDays,
    allowQtyp: 'GB',
    pool,
    roamingProfileId,
    servingNetworks,
    occurrences,
    allowThrottle,
    allowTethering,
  } as FingerprintSource)

  // 5. Create / load the durable operation.
  const loaded = await loadOrCreateUpstreamOperation({
    idempotencyKey,
    requestFingerprint: fingerprint,
    providerId: provider.id,
    providerCode: provider.code,
    requestedSku: sku,
    requestedByName: name,
    requestedBy: userId,
  })

  if (loaded.conflict) {
    return { success: false, error: loaded.conflictReason || 'Idempotency conflict', category: 'UNKNOWN' }
  }
  const op = loaded.op

  // 6. Replay / recovery fast-paths (NEVER re-create upstream).
  if (op.status === UPSTREAM_OP_STATUS.COMPLETED) {
    return buildCompletedResult(op)
  }
  if (op.status === UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED || op.status === UPSTREAM_OP_STATUS.PARTIAL_FAILURE || op.status === UPSTREAM_OP_STATUS.LOCAL_PERSISTING) {
    const resumed = await resumeLocalPersistence(op, request, provider, userId)
    return resumed
  }
  if (op.status === UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS) {
    // A previous worker either (a) is still actively running the provider call,
    // or (b) crashed mid-request and its lease has expired. We can NEVER blindly
    // re-create. If the lease is still fresh, another worker owns it — leave it
    // alone. If the lease has expired, the upstream outcome is unknowable →
    // AMBIGUOUS_UPSTREAM_RESULT (reconciliation required), never a re-create.
    const leaseActive = await isUpstreamOperationLeaseActive(op.id)
    if (leaseActive) {
      return { success: false, error: 'This operation is already being processed by another request.', operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey }
    }
    await markUpstreamOperationAmbiguous(op.id, { code: 'STALE_IN_PROGRESS', message: 'Prior worker did not record the upstream outcome before its lease expired.' })
    return {
      success: false,
      requiresReconciliation: true,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      providerId: provider.id,
      providerCode: provider.code,
      providerReference: op.upstreamReference || undefined,
      category: 'AMBIGUOUS',
      error: 'Provider creation status could not be confirmed. Do not retry creation manually — reconciliation is required.',
    }
  }
  if (op.status === UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT) {
    return {
      success: false,
      requiresReconciliation: true,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      providerId: provider.id,
      providerCode: provider.code,
      providerReference: op.upstreamReference || undefined,
      category: 'AMBIGUOUS',
      error: 'Provider creation status could not be confirmed. Do not retry creation manually — reconciliation is required.',
    }
  }
  if (op.status === UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS) {
    // A prior run determined the upstream object already exists without a safe
    // read-back match — do not blindly attach/local-create.
    return {
      success: false,
      requiresReconciliation: true,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      providerId: provider.id,
      providerCode: provider.code,
      providerReference: op.upstreamReference || undefined,
      category: 'ALREADY_EXISTS',
      error: 'This provider SKU already exists upstream. Reconciliation is required before attaching it.',
    }
  }
  if (op.status === UPSTREAM_OP_STATUS.FAILED) {
    // A prior validation/entitlement failure is terminal for this key; a new
    // attempt must use a fresh idempotency key (no blind retry of a provider
    // rejection that may have been ambiguous).
    if ((op as any).lastErrorCode === 'CHOICE_ALREADY_EXISTS' || (op as any).lastErrorCode?.toUpperCase().includes('AMBIGUOUS')) {
      return {
        success: false,
        requiresReconciliation: true,
        operationId: op.id,
        upstreamIdempotencyKey: op.idempotencyKey,
        providerId: provider.id,
        providerCode: provider.code,
        category: 'AMBIGUOUS',
        error: 'Provider creation status could not be confirmed. Do not retry creation manually.',
      }
    }
    return { success: false, error: (op as any).lastErrorMessageSafe || 'This operation previously failed; use a new idempotency key to create again.', category: 'FAILED' as any, operationId: op.id }
  }

  // 7. Acquire the single-writer lease.
  const lease = await acquireUpstreamOperationLease(op.id)
  if (!lease.acquired) {
    return { success: false, error: 'Another request is already processing this operation. Please retry shortly.', operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey }
  }

  // 8. CAS: PENDING → UPSTREAM_IN_PROGRESS. If we lose the race, another writer
  //    owns it; never double-create.
  const claimed = await transitionUpstreamOperation(op.id, UPSTREAM_OP_STATUS.PENDING, UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS, { upstreamStartedAt: new Date() })
  if (!claimed) {
    // Re-read: the other writer may have completed/advanced — return its outcome.
    const freshOp = await prisma.upstreamPackageCreationOperation.findUnique({ where: { id: op.id } })
    if (freshOp?.status === UPSTREAM_OP_STATUS.COMPLETED) return buildCompletedResult(freshOp)
    return { success: false, error: 'This operation is already being processed by another request.', operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey }
  }

  // 9. Call the provider ONCE.
  const upstreamResult: {
    success: boolean
    data?: { providerPlanId?: string; providerPlanCode?: string; status?: string }
    error?: { code: string; message: string }
  } = await connector
    .createCustomPackage({
      name,
      dataGB,
      validityDays,
      countries: request.countries,
      providerValues: normalizeProviderValues(pv),
    })
    .then(
      (r) => ({
        success: r.success,
        data: r.data,
        error: r.error,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => ({ success: false, error: { code: 'CONNECTOR_ERROR', message: e?.message || 'Upstream call threw' } }),
    )

  if (upstreamResult.success && upstreamResult.data?.providerPlanId) {
    // 10. Persist upstream success IMMEDIATELY (durable).
    const upstreamRef = upstreamResult.data.providerPlanId
    const extId = upstreamResult.data.providerPlanCode || upstreamRef
    await transitionUpstreamOperation(op.id, UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS, UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED, {
      upstreamReference: upstreamRef,
      upstreamExternalId: extId,
      upstreamCompletedAt: new Date(),
    })

    // 11. Local persistence (idempotent, recoverable).
    const persisted = await persistLocalUpstream(loaded, request, provider, userId, upstreamRef, extId)
    if (persisted.success) {
      await transitionUpstreamOperation(op.id, UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED, UPSTREAM_OP_STATUS.COMPLETED, { localCompletedAt: new Date(), esimPackageId: persisted.esimPackageId, providerPackageId: persisted.localProviderPackageId })
      return {
        success: true,
        esimPackageId: persisted.esimPackageId,
        providerPackageId: persisted.localProviderPackageId,
        providerPackageIds: [persisted.localProviderPackageId],
        localProviderPackageId: persisted.localProviderPackageId,
        providerId: provider.id,
        providerCode: provider.code,
        operationId: op.id,
        upstreamIdempotencyKey: op.idempotencyKey,
        providerReference: upstreamRef,
      }
    }

    // 12. Partial failure: upstream succeeded, local persistence broke.
    await transitionUpstreamOperation(op.id, UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED, UPSTREAM_OP_STATUS.PARTIAL_FAILURE, {
      lastErrorCode: 'LOCAL_PERSIST_FAILED',
      lastErrorMessageSafe: (persisted.error || '').slice(0, 500),
      recoveryState: { providerPlanId: upstreamRef, providerPlanCode: extId },
    })
    return {
      success: false,
      partialFailure: true,
      providerReference: upstreamRef,
      providerPackageId: upstreamRef,
      providerId: provider.id,
      providerCode: provider.code,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      category: 'UNKNOWN',
      error: `Provider package "${upstreamRef}" was created, but OneSIM could not finish local setup. Recovery is available. (${persisted.error})`,
    }
  }

  // 13. Upstream call failed — classify the outcome.
  const category = classifyUpstreamCreateError(upstreamResult.success ? undefined : upstreamResult.error)
  const errCode = upstreamResult.error?.code || 'UNKNOWN'
  const errMsg = upstreamResult.error?.message || 'Upstream package creation failed'

  if (category === 'AMBIGUOUS') {
    await markUpstreamOperationAmbiguous(op.id, { code: errCode, message: errMsg })
    return {
      success: false,
      requiresReconciliation: true,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      providerId: provider.id,
      providerCode: provider.code,
      category: 'AMBIGUOUS',
      error: 'Provider creation status could not be confirmed. Do not retry creation manually — reconciliation is required.',
    }
  }
  if (category === 'ALREADY_EXISTS') {
    await markUpstreamOperationAlreadyExists(op.id, { message: errMsg })
    return {
      success: false,
      requiresReconciliation: true,
      operationId: op.id,
      upstreamIdempotencyKey: op.idempotencyKey,
      providerId: provider.id,
      providerCode: provider.code,
      category: 'ALREADY_EXISTS',
      error: 'This provider SKU already exists upstream. Reconciliation is required before attaching it.',
    }
  }

  await markUpstreamOperationFailed(op.id, { code: errCode, message: errMsg })
  return { success: false, error: errMsg, category, providerId: provider.id, providerCode: provider.code, operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey }
}

/** Build a result from a COMPLETED operation (replay fast-path). */
function buildCompletedResult(op: any): CustomPackageCreateResult {
  return {
    success: true,
    esimPackageId: op.esimPackageId || undefined,
    providerPackageId: op.providerPackageId || op.upstreamReference || undefined,
    providerPackageIds: op.providerPackageId ? [op.providerPackageId] : (op.upstreamReference ? [op.upstreamReference] : []),
    localProviderPackageId: op.providerPackageId || undefined,
    providerId: op.providerId,
    providerCode: op.providerCode,
    operationId: op.id,
    upstreamIdempotencyKey: op.idempotencyKey,
    providerReference: op.upstreamReference || undefined,
  }
}

/**
 * Resume local persistence for an operation that already succeeded upstream.
 * Idempotent: reads/reuses existing ProviderPackage + ESIMPackage + binding
 * rather than creating duplicates. Atomic in a single Prisma transaction.
 */
async function persistLocalUpstream(
  loaded: any,
  request: CustomPackageCreateRequest,
  provider: any,
  userId: string,
  upstreamRef: string,
  extId: string,
): Promise<LocalUpstreamPersistResult> {
  try {
    const { name, dataGB, validityDays, sellingPrice, currency } = request
    const displayName = (request.displayName || name).trim() || name

    // Stable ProviderPackage key: providerId + providerPlanId (upstream SKU).
    const existingProviderPackage = await prisma.providerPackage.findFirst({
      where: { providerId: provider.id, providerPlanId: upstreamRef },
      select: { id: true },
    })

    return await prisma.$transaction(async (tx) => {
      const providerPackageId =
        existingProviderPackage?.id ||
        (await tx.providerPackage.create({
          data: {
            providerId: provider.id,
            providerPlanId: upstreamRef,
            providerPlanCode: extId,
            name,
            dataGB,
            validityDays,
            costPrice: 0,
            sellingPrice: 0,
            adminCostPrice: null,
            currency: (provider as any).currency || 'USD',
            configurationStatus: 'UNCONFIGURED',
            publishStatus: 'READY',
            pricingStatus: 'COST_UNAVAILABLE' as any,
            costStatus: 'MISSING',
            country: request.countries?.[0] || 'GLOBAL',
            isAvailable: true,
          },
        })).id

      const existingRetail = await tx.eSIMPackage.findFirst({
        where: { providerRawData: { path: ['upstream', 'providerPlanId'], equals: upstreamRef } },
        select: { id: true },
      })
      const esimPackageId = existingRetail?.id || (await tx.eSIMPackage.create({
        data: {
          name,
          displayName,
          description: request.description || null,
          customerDescription: request.description || null,
          dataGB,
          validityDays,
          priceUSD: sellingPrice,
          localPrice: sellingPrice,
          currency,
          isActive: true,
          source: 'CATALOG_PRODUCT',
          productType: request.productType || 'NEW_ESIM',
          hiddenFromCatalog: false,
          archivedAt: null,
          providerPackageId: null,
          providerRawData: {
            customPackage: { mode: 'UPSTREAM_CREATE', upstreamProviderId: provider.id, upstreamProviderCode: provider.code, operationId: (loaded.op?.id) },
            upstream: { providerPlanId: upstreamRef, providerPlanCode: extId, localProviderPackageId: providerPackageId },
            createdBy: userId,
          },
        },
      })).id

      // Binding idempotency: @@unique([esimPackageId, providerPackageId]) makes a
      // duplicate insert fail-safe; use createMany skipping duplicates for clean resume.
      await tx.eSIMPackageProviderBinding.upsert({
        where: { esimPackageId_providerPackageId: { esimPackageId, providerPackageId } },
        create: { esimPackageId, providerPackageId, priority: 1, isActive: true },
        update: { isActive: true },
      })

      return { success: true, esimPackageId, localProviderPackageId: providerPackageId }
    })
  } catch (e: any) {
    return { success: false, error: e?.message || 'Local persistence failed' }
  }
}

/** Resume local persistence from PARTIAL_FAILURE / UPSTREAM_SUCCEEDED / LOCAL_PERSISTING. */
async function resumeLocalPersistence(op: any, request: CustomPackageCreateRequest, provider: any, userId: string): Promise<CustomPackageCreateResult> {
  const ref = op.upstreamReference || String(request.providerValues?.sku || '').trim()
  if (!ref) {
    return { success: false, requiresReconciliation: true, operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey, category: 'AMBIGUOUS', error: 'Upstream reference is missing; reconciliation required.' }
  }
  const persisted = await persistLocalUpstream({ op }, request, provider, userId, ref, op.upstreamExternalId || ref)
  if (!persisted.success) {
    return { success: false, partialFailure: true, providerReference: ref, providerPackageId: ref, providerId: provider.id, providerCode: provider.code, operationId: op.id, upstreamIdempotencyKey: op.idempotencyKey, category: 'UNKNOWN', error: `Provider package "${ref}" was created, but OneSIM could not finish local setup. Recovery is available. (${persisted.error})` }
  }
  await prisma.upstreamPackageCreationOperation.update({
    where: { id: op.id },
    data: { status: UPSTREAM_OP_STATUS.COMPLETED, localCompletedAt: new Date(), esimPackageId: persisted.esimPackageId, providerPackageId: persisted.localProviderPackageId, updatedAt: new Date() },
  }).catch(() => {})
  return {
    success: true,
    esimPackageId: persisted.esimPackageId,
    providerPackageId: ref,
    providerPackageIds: [ref],
    localProviderPackageId: persisted.localProviderPackageId,
    providerId: provider.id,
    providerCode: provider.code,
    operationId: op.id,
    upstreamIdempotencyKey: op.idempotencyKey,
  }
}

/** Regression-only helper: normalize the safe provider values passed upstream. */
function normalizeProviderValues(pv: Record<string, unknown>): Record<string, unknown> {
  const allowlistKeys = ['sku', 'bundle_name', 'pool', 'rate_group_allowance', 'rate_group_allow_qtyp', 'rate_group_allow_days', 'rate_group_occurrences', 'roaming_profile_id', 'allow_throttle', 'allow_tethering', 'serving_networks']
  const out: Record<string, unknown> = {}
  for (const key of allowlistKeys) {
    if (pv[key] !== undefined) out[key] = pv[key]
  }
  return out
}