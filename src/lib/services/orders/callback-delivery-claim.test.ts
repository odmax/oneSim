import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND CALLBACK DELIVERY CLAIM — concurrency contract tests (A, B, F, G)
//
// claimOrderCallbackDelivery must decide, ONCE at the DB level, whether a
// worker owns the right to POST a callback. It is a single atomic
// UPDATE ... WHERE eligible-condition (Prisma updateMany). These tests:
//   1. assert the exact eligibility/due/claim-guard `where` + claim `data`;
//   2. run the function against a stateful harness that emulates the atomic
//      row-level guard, demonstrating A/B/F/G through the real function.
//
// The route-level guarantee "the loser performs ZERO outbound HTTP requests"
// is proven in order-callback-delivery/route.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const harness = vi.hoisted(() => {
  type Delivery = { status: string; nextAttemptAt: number | null; claimedUntil: number | null; claimOwner: string | null }
  const store = new Map<string, Delivery>()

  /** Emulates the atomic UPDATE ... WHERE guard:
   *  claim iff eligible status AND due AND (unclaimed OR claim expired). */
  function dbClaim(id: string, claimOwner: string, claimedUntilMs: number, now: number): { count: number } {
    const d = store.get(id)
    if (!d) return { count: 0 }
    if (d.status !== 'PENDING' && d.status !== 'RETRY_SCHEDULED') return { count: 0 }
    if (d.nextAttemptAt == null || d.nextAttemptAt > now) return { count: 0 }
    if (d.claimedUntil != null && d.claimedUntil > now) return { count: 0 }
    d.claimOwner = claimOwner
    d.claimedUntil = claimedUntilMs
    return { count: 1 }
  }

  const seed = (id: string, partial: Partial<Delivery> = {}) => {
    store.set(id, {
      status: 'PENDING',
      nextAttemptAt: Date.now() - 5_000,
      claimedUntil: null,
      claimOwner: null,
      ...partial,
    })
  }

  return { store, dbClaim, seed, mockUpdateMany: vi.fn() }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    orderCallbackDelivery: { updateMany: harness.mockUpdateMany },
  },
}))

import { claimOrderCallbackDelivery, CALLBACK_CLAIM_TTL_MS } from './callback-delivery-claim'

beforeEach(() => {
  harness.store.clear()
  harness.mockUpdateMany.mockReset().mockImplementation(
    (args: { where: { id: string }; data: { claimOwner: string; claimedUntil: Date } }) =>
      Promise.resolve(harness.dbClaim(args.where.id, args.data.claimOwner, new Date(args.data.claimedUntil).getTime(), Date.now())),
  )
})

describe('callback-delivery-claim — eligibility/claim contract', () => {
  it('A: an eligible callback can be claimed; the claim writes owner + TTL and nowhere else', async () => {
    harness.seed('del-1')
    const ok = await claimOrderCallbackDelivery('del-1', 'replica-1')
    expect(ok).toBe(true)
    expect(harness.store.get('del-1')?.claimOwner).toBe('replica-1')

    const args = harness.mockUpdateMany.mock.calls[0][0]
    expect(args.where.id).toBe('del-1')
    // Eligible non-terminal statuses only — terminals can never match.
    expect(args.where.status).toEqual({ in: ['PENDING', 'RETRY_SCHEDULED'] })
    // Must be due (nextAttemptAt <= now).
    expect(args.where.nextAttemptAt.lte).toBeInstanceOf(Date)
    // Must not be claimed by a live owner.
    expect(args.where.OR).toEqual([{ claimedUntil: null }, { claimedUntil: { lte: expect.any(Date) } }])
    // Data writes ONLY the claim fields (attempt accounting / status untouched).
    expect(args.data).toEqual({ claimOwner: 'replica-1', claimedUntil: expect.any(Date) })
    const ttl = new Date(args.data.claimedUntil as Date).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(CALLBACK_CLAIM_TTL_MS - 2_000)
    expect(ttl).toBeLessThan(CALLBACK_CLAIM_TTL_MS + 5_000)
  })

  it('B: a concurrent second claim on the same delivery loses (exactly one winner)', async () => {
    harness.seed('del-1')
    expect(await claimOrderCallbackDelivery('del-1', 'replica-1')).toBe(true)
    const ok2 = await claimOrderCallbackDelivery('del-1', 'replica-2')
    expect(ok2).toBe(false)
    expect(harness.store.get('del-1')?.claimOwner).toBe('replica-1')
  })

  it('F: a stale/crashed claim becomes retryable as soon as claimedUntil passes', async () => {
    harness.seed('del-1', { status: 'RETRY_SCHEDULED', claimedUntil: Date.now() - 5_000, claimOwner: 'crashed-worker' })
    const ok = await claimOrderCallbackDelivery('del-1', 'new-worker')
    expect(ok).toBe(true)
    expect(harness.store.get('del-1')?.claimOwner).toBe('new-worker')
  })

  it('G: terminal callbacks can never be reclaimed', async () => {
    for (const status of ['DELIVERED', 'DEAD_LETTERED', 'CANCELLED', 'FAILED']) {
      harness.seed(`del-${status}`, { status })
      expect(await claimOrderCallbackDelivery(`del-${status}`, 'replica-1')).toBe(false)
    }
    // The eligibility whitelist provably excludes terminals.
    const args = harness.mockUpdateMany.mock.calls[0][0]
    expect(args.where.status.in).toEqual(['PENDING', 'RETRY_SCHEDULED'])
  })

  it('preserves retry behavior: a due RETRY_SCHEDULED delivery can be claimed again', async () => {
    harness.seed('del-1', { status: 'RETRY_SCHEDULED', nextAttemptAt: Date.now() - 60_000 })
    expect(await claimOrderCallbackDelivery('del-1', 'replica-1')).toBe(true)
    // The claim never touched status or attempt accounting.
    expect(harness.store.get('del-1')?.status).toBe('RETRY_SCHEDULED')
  })

  it('a not-yet-due delivery cannot be claimed', async () => {
    harness.seed('del-1', { nextAttemptAt: Date.now() + 60_000 })
    expect(await claimOrderCallbackDelivery('del-1', 'replica-1')).toBe(false)
  })

  it('guards empty deliveryId/owner and non-positive ttl without touching the DB', async () => {
    expect(await claimOrderCallbackDelivery('', 'owner')).toBe(false)
    expect(await claimOrderCallbackDelivery('d', '')).toBe(false)
    expect(await claimOrderCallbackDelivery('d', 'o', 0)).toBe(false)
    expect(harness.mockUpdateMany).not.toHaveBeenCalled()
  })
})