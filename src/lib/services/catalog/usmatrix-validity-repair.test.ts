import { describe, it, expect, vi } from 'vitest'
import { planUsMatrixValidityRepair, applyUsMatrixValidityRepair } from './usmatrix-validity-repair'

function pp(id: string, validityDays: number | null, limit: number | null, limitType = 'day', rawLimit = limit) {
  return {
    id,
    validityDays,
    providerRawData: rawLimit === null ? { limitType: 'week' } : { limit: rawLimit, limitType, start: '2026-08-13T00:00:02.000Z', end: '2026-09-12T23:59:58.000Z' },
  }
}

describe('planUsMatrixValidityRepair — source-backed, fail closed, idempotent', () => {
  it('dry-run counters reflect a 7-day source-backed correction for a wrongly-persisted 30', () => {
    const plan = planUsMatrixValidityRepair(
      [pp('pp-7', 30, 7)],
      [{ id: 'retail-7', validityDays: 30, providerPackageId: 'pp-7' }],
      1,
    )
    expect(plan.counters).toMatchObject({
      USMATRIX_PROVIDER_COUNT: 1,
      PROVIDER_PACKAGE_SCANNED: 1,
      PROVIDER_PACKAGE_ELIGIBLE: 1,
      PROVIDER_PACKAGE_WOULD_UPDATE: 1,
      PROVIDER_PACKAGE_ALREADY_CORRECT: 0,
      PROVIDER_PACKAGE_INVALID_SOURCE: 0,
      RETAIL_PACKAGE_SCANNED: 1,
      RETAIL_PACKAGE_WOULD_UPDATE: 1,
      RETAIL_PACKAGE_ALREADY_CORRECT: 0,
      HISTORICAL_ORDER_UPDATE_COUNT: 0,
      PROVIDER_CALL_COUNT: 0,
    })
    expect(plan.updates).toContainEqual({ kind: 'PROVIDER_PACKAGE', id: 'pp-7', from: 30, to: 7 })
    expect(plan.updates).toContainEqual({ kind: 'RETAIL_PACKAGE', id: 'retail-7', from: 30, to: 7 })
  })

  it('already-correct rows are never re-planned (idempotent second pass)', () => {
    const plan = planUsMatrixValidityRepair([pp('pp-ok', 7, 7)], [{ id: 'r-ok', validityDays: 7, providerPackageId: 'pp-ok' }], 1)
    expect(plan.counters.PROVIDER_PACKAGE_WOULD_UPDATE).toBe(0)
    expect(plan.counters.PROVIDER_PACKAGE_ALREADY_CORRECT).toBe(1)
    expect(plan.counters.RETAIL_PACKAGE_WOULD_UPDATE).toBe(0)
    expect(plan.counters.RETAIL_PACKAGE_ALREADY_CORRECT).toBe(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('invalid source (unsupported unit / null limit) is FAIL CLOSED: never 30, retail untouched', () => {
    const plan = planUsMatrixValidityRepair(
      [
        { id: 'pp-bad', validityDays: 30, providerRawData: { limit: 30, limitType: 'week' } },
        { id: 'pp-null', validityDays: 30, providerRawData: { limit: null, limitType: 'day' } },
      ],
      [{ id: 'r-bad', validityDays: 30, providerPackageId: 'pp-bad' }],
      1,
    )
    expect(plan.counters.PROVIDER_PACKAGE_INVALID_SOURCE).toBe(2)
    expect(plan.counters.PROVIDER_PACKAGE_WOULD_UPDATE).toBe(0)
    expect(plan.counters.RETAIL_PACKAGE_WOULD_UPDATE).toBe(0)
    expect(plan.updates).toHaveLength(0)
  })

  it('accepts numeric-string limit and string providerRawData', () => {
    const plan = planUsMatrixValidityRepair(
      [{ id: 'pp-s', validityDays: 30, providerRawData: JSON.stringify({ limit: '15', limitType: 'day' }) }],
      [],
      1,
    )
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toEqual({ kind: 'PROVIDER_PACKAGE', id: 'pp-s', from: 30, to: 15 })
  })
})

describe('applyUsMatrixValidityRepair — single transaction, idempotent', () => {
  it('applies provider+retail updates once inside one transaction', async () => {
    const db = {
      providerPackage: { update: vi.fn(async (a: any) => a) },
      eSIMPackage: { update: vi.fn(async (a: any) => a) },
      $transaction: vi.fn(async (ops: any[]) => { for (const o of ops) await o; return ops }),
    }
    const plan = planUsMatrixValidityRepair([pp('pp-7', 30, 7)], [{ id: 'r-7', validityDays: 30, providerPackageId: 'pp-7' }], 1)
    const { applied } = await applyUsMatrixValidityRepair(db as any, plan)
    expect(applied).toBe(2)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.providerPackage.update).toHaveBeenCalledWith({ where: { id: 'pp-7' }, data: { validityDays: 7 } })
    expect(db.eSIMPackage.update).toHaveBeenCalledWith({ where: { id: 'r-7' }, data: { validityDays: 7 } })
  })

  it('no-op when the plan has zero updates (idempotent re-run)', async () => {
    const db = { providerPackage: { update: vi.fn() }, eSIMPackage: { update: vi.fn() }, $transaction: vi.fn() }
    const plan = planUsMatrixValidityRepair([pp('pp-ok', 7, 7)], [], 1)
    const { applied } = await applyUsMatrixValidityRepair(db as any, plan)
    expect(applied).toBe(0)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})