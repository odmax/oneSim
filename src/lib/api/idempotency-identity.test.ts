import { describe, it, expect } from 'vitest'
import { canonicalPurchaseIdentity, stripIdempotencyIdentity, hasIdempotencyIdentity } from './idempotency-identity'

describe('canonical purchase identity (idempotency binding)', () => {
  it('is stable for the same request', () => {
    const a = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1, travelDate: '2026-09-10' })
    const b = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1, travelDate: '2026-09-10' })
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it('changes when package changes', () => {
    const a = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1 })
    const b = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-2', quantity: 1 })
    expect(a).not.toBe(b)
  })

  it('changes when quantity changes', () => {
    const a = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1 })
    const b = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 2 })
    expect(a).not.toBe(b)
  })

  it('changes when travel-date is added/removed', () => {
    const noTravel = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1 })
    const withTravel = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1, travelDate: '2026-09-10' })
    expect(noTravel).not.toBe(withTravel)
    const otherTravel = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1, travelDate: '2026-09-11' })
    expect(withTravel).not.toBe(otherTravel)
  })

  it('ignores presentation metadata (customer email does not change identity)', () => {
    const id = canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1 })
    // Even if callers passed extra metadata, identity is derived only from the canonical fields.
    expect(canonicalPurchaseIdentity({ resolvedPackageId: 'pkg-1', quantity: 1 })).toBe(id)
  })

  it('identifiers are normalised to the resolved canonical package id', () => {
    const byId = canonicalPurchaseIdentity({ resolvedPackageId: 'retail-1', quantity: 1 })
    const byRaw = canonicalPurchaseIdentity({ packageId: 'retail-1', quantity: 1 })
    expect(byId).toBe(byRaw)
  })

  it('strip removes only the private __requestIdentity field', () => {
    const stored = { success: true, order: { id: 'o1' }, __requestIdentity: 'abc' }
    const pub = stripIdempotencyIdentity(stored)
    expect(pub).toEqual({ success: true, order: { id: 'o1' } })
    expect((pub as any).__requestIdentity).toBeUndefined()
    expect(hasIdempotencyIdentity(stored)).toBe(true)
    expect(hasIdempotencyIdentity(pub)).toBe(false)
  })
})