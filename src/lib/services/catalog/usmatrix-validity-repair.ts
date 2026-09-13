import { parseUsMatrixValidityDays } from '@/lib/providers/connectors/usmatrix-connector'

/**
 * GUARDED source-backed US-Matrix validity repair (DRY-RUN by default).
 *
 * The authoritative service validity for a US-Matrix package is the confirmed
 * live contract value: raw.limit (positive finite integer) + raw.limitType
 * "day" (case-insensitive). It is NEVER start/end (availability window) and
 * NEVER the plan name.
 *
 * Scope: current catalog records only — ProviderPackage rows of US-Matrix
 * providers and their linked retail ESIMPackage catalog products. It NEVER
 * touches historical orders, snapshots, completed eSIM expiry, wallet records,
 * provider attempts, SKUs/package identity, pricing, or any provider call.
 *
 * Fail closed: rows whose providerRawData does not encode a provable duration
 * (INVALID_SOURCE) are never guessed to 30.
 */

export interface RepairPackageRow {
  id: string
  validityDays: number | null
  providerRawData: unknown
}

export interface RepairRetailRow {
  id: string
  validityDays: number | null
  providerPackageId: string | null
}

export interface RepairCounters {
  USMATRIX_PROVIDER_COUNT: number
  PROVIDER_PACKAGE_SCANNED: number
  PROVIDER_PACKAGE_ELIGIBLE: number
  PROVIDER_PACKAGE_WOULD_UPDATE: number
  PROVIDER_PACKAGE_ALREADY_CORRECT: number
  PROVIDER_PACKAGE_INVALID_SOURCE: number
  RETAIL_PACKAGE_SCANNED: number
  RETAIL_PACKAGE_WOULD_UPDATE: number
  RETAIL_PACKAGE_ALREADY_CORRECT: number
  HISTORICAL_ORDER_UPDATE_COUNT: number
  PROVIDER_CALL_COUNT: number
}

export interface PlannedUpdate {
  kind: 'PROVIDER_PACKAGE' | 'RETAIL_PACKAGE'
  id: string
  from: number | null
  to: number
}

export interface RepairPlan {
  counters: RepairCounters
  updates: PlannedUpdate[]
}

function emptyCounters(providerCount: number): RepairCounters {
  return {
    USMATRIX_PROVIDER_COUNT: providerCount,
    PROVIDER_PACKAGE_SCANNED: 0,
    PROVIDER_PACKAGE_ELIGIBLE: 0,
    PROVIDER_PACKAGE_WOULD_UPDATE: 0,
    PROVIDER_PACKAGE_ALREADY_CORRECT: 0,
    PROVIDER_PACKAGE_INVALID_SOURCE: 0,
    RETAIL_PACKAGE_SCANNED: 0,
    RETAIL_PACKAGE_WOULD_UPDATE: 0,
    RETAIL_PACKAGE_ALREADY_CORRECT: 0,
    HISTORICAL_ORDER_UPDATE_COUNT: 0,
    PROVIDER_CALL_COUNT: 0,
  }
}

function rawDuration(providerRawData: unknown): number {
  let raw: unknown = providerRawData
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { raw = null }
  }
  return raw && typeof raw === 'object'
    ? parseUsMatrixValidityDays(raw as { limit?: unknown; limitType?: unknown })
    : 0
}

/**
 * Pure, deterministic planning. Idempotent: a second pass over corrected rows
 * yields zero WOULD_UPDATE rows.
 */
export function planUsMatrixValidityRepair(
  packages: RepairPackageRow[],
  retail: RepairRetailRow[],
  providerCount = 1,
): RepairPlan {
  const counters = emptyCounters(providerCount)
  const updates: PlannedUpdate[] = []
  const retailByPkg = new Map<string, RepairRetailRow[]>()
  for (const r of retail) {
    const key = r.providerPackageId || ''
    if (!key) continue
    const list = retailByPkg.get(key) || []
    list.push(r)
    retailByPkg.set(key, list)
  }

  for (const pkg of packages) {
    counters.PROVIDER_PACKAGE_SCANNED++
    const target = rawDuration(pkg.providerRawData)
    if (!(target > 0)) {
      counters.PROVIDER_PACKAGE_INVALID_SOURCE++
      continue
    }
    counters.PROVIDER_PACKAGE_ELIGIBLE++
    if (pkg.validityDays === target) {
      counters.PROVIDER_PACKAGE_ALREADY_CORRECT++
    } else {
      counters.PROVIDER_PACKAGE_WOULD_UPDATE++
      updates.push({ kind: 'PROVIDER_PACKAGE', id: pkg.id, from: pkg.validityDays, to: target })
    }

    for (const r of retailByPkg.get(pkg.id) || []) {
      counters.RETAIL_PACKAGE_SCANNED++
      if (r.validityDays === target) {
        counters.RETAIL_PACKAGE_ALREADY_CORRECT++
      } else {
        counters.RETAIL_PACKAGE_WOULD_UPDATE++
        updates.push({ kind: 'RETAIL_PACKAGE', id: r.id, from: r.validityDays, to: target })
      }
    }
  }

  return { counters, updates }
}

interface RepairDbLike {
  $transaction: (ops: any[]) => Promise<unknown>
  providerPackage: { update: (arg: { where: { id: string }; data: { validityDays: number } }) => Promise<unknown> }
  eSIMPackage: { update: (arg: { where: { id: string }; data: { validityDays: number } }) => Promise<unknown> }
}

/**
 * Apply a plan inside a single transaction. Idempotent: planning over already
 * applied rows yields an empty updates list, so this is a no-op on re-run.
 */
export async function applyUsMatrixValidityRepair(db: RepairDbLike, plan: RepairPlan): Promise<{ applied: number }> {
  const ops = plan.updates.map((u) =>
    u.kind === 'PROVIDER_PACKAGE'
      ? db.providerPackage.update({ where: { id: u.id }, data: { validityDays: u.to } })
      : db.eSIMPackage.update({ where: { id: u.id }, data: { validityDays: u.to } }),
  )
  if (ops.length === 0) return { applied: 0 }
  await db.$transaction(ops)
  return { applied: ops.length }
}