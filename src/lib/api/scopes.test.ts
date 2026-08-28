import { describe, it, expect } from 'vitest'
import { classifyV1Route, hasScope, assertKnownV1ScopePolicy, isKnownV1Route, scopesForRoute, ROUTE_SCOPE_MAP, V1_BOOTSTRAP_ROUTES, RESERVED_SCOPES, API_SCOPES } from './scopes'

describe('classifyV1Route — fail-closed route policy', () => {
  it('matches literal protected routes exactly', () => {
    expect(classifyV1Route('GET', '/api/v1/packages')).toEqual({ kind: 'PROTECTED', scopes: ['packages:read'] })
    expect(classifyV1Route('POST', '/api/v1/esims/order')).toEqual({ kind: 'PROTECTED', scopes: ['orders:write'] })
    expect(classifyV1Route('GET', '/api/v1/wallet/transactions')).toEqual({ kind: 'PROTECTED', scopes: ['wallet:read'] })
  })

  it('dynamic [id] placeholder routes match by regex and resolve their scope', () => {
    expect(classifyV1Route('GET', '/api/v1/esims/esim_123abc/usage')).toEqual({ kind: 'PROTECTED', scopes: ['esims:read'] })
    expect(classifyV1Route('POST', '/api/v1/esims/esim_123abc/refresh-qr')).toEqual({ kind: 'PROTECTED', scopes: ['esims:write'] })
    expect(classifyV1Route('POST', '/api/v1/esims/esim_123abc/top-up')).toEqual({ kind: 'PROTECTED', scopes: ['esims:write'] })
    expect(classifyV1Route('POST', '/api/v1/webhooks/deliveries/deliv-1/retry')).toEqual({ kind: 'PROTECTED', scopes: ['webhooks:write'] })
  })

  it('bootstrap routes are explicitly classed (AUTH / PUBLIC), not UNREGISTERED', () => {
    expect(classifyV1Route('GET', '/api/v1/auth/verify')).toEqual({ kind: 'BOOTSTRAP', auth: 'AUTH' })
    expect(classifyV1Route('GET', '/api/v1/esims/order')).toEqual({ kind: 'BOOTSTRAP', auth: 'PUBLIC' })
  })

  it('FAIL-CLOSED: any unknown /api/v1 route is UNREGISTERED (never implicit allow)', () => {
    expect(classifyV1Route('POST', '/api/v1/esims/[id]/does-not-exist')).toEqual({ kind: 'UNREGISTERED' })
    expect(classifyV1Route('POST', '/api/v1/wallet/transfer')).toEqual({ kind: 'UNREGISTERED' })
    expect(classifyV1Route('GET', '/api/v1/future/route')).toEqual({ kind: 'UNREGISTERED' })
  })

  it('isKnownV1Route true for protected + bootstrap, false for unknown', () => {
    expect(isKnownV1Route('GET', '/api/v1/packages')).toBe(true)
    expect(isKnownV1Route('GET', '/api/v1/auth/verify')).toBe(true)
    expect(isKnownV1Route('DELETE', '/api/v1/undeclared')).toBe(false)
  })

  it('assertKnownV1ScopePolicy throws (fails closed) for unregistered routes only', () => {
    expect(() => assertKnownV1ScopePolicy('GET', '/api/v1/packages')).not.toThrow()
    expect(() => assertKnownV1ScopePolicy('GET', '/api/v1/auth/verify')).not.toThrow()
    expect(() => assertKnownV1ScopePolicy('PATCH', '/api/v1/esims/[id]/suspend')).toThrow(/No API scope policy/i)
  })

  it('scopesForRoute returns [] for bootstrap and UNREGISTERED (fails closed upstream)', () => {
    expect(scopesForRoute('GET', '/api/v1/auth/verify')).toEqual([])
    expect(scopesForRoute('POST', '/api/v1/unknown-route')).toEqual([])
  })

  it('ignore query strings and method case', () => {
    expect(classifyV1Route('get', '/api/v1/packages?page=2')).toEqual({ kind: 'PROTECTED', scopes: ['packages:read'] })
  })
})

describe('scope registry totality', () => {
  it('every ROUTE_SCOPE_MAP entry uses a canonical scope', () => {
    for (const scopes of Object.values(ROUTE_SCOPE_MAP)) {
      for (const s of scopes) {
        expect(Object.keys(API_SCOPES)).toContain(s)
      }
    }
  })

  it('refresh-qr is explicitly present in the protected map', () => {
    expect(classifyV1Route('POST', '/api/v1/esims/[id]/refresh-qr')).toEqual({ kind: 'PROTECTED', scopes: ['esims:write'] })
  })

  it('V1_BOOTSTRAP_ROUTES documents only deliberate public/auth endpoints', () => {
    const keys = Object.keys(V1_BOOTSTRAP_ROUTES)
    expect(keys).toContain('GET /api/v1/auth/verify')
    expect(keys).toContain('GET /api/v1/esims/order')
    // No business data resource may ever be bootstrap-exempt.
    for (const k of keys) {
      expect(k).not.toMatch(/webhooks|wallet|customers|orders|usage|top-up/)
    }
  })

  it('quotes:write is declared RESERVED (no route) — not silently dead', () => {
    expect(RESERVED_SCOPES).toContain('quotes:write')
    // No current route consumes it (if one is added, the totality test will
    // require it in ROUTE_SCOPE_MAP).
    expect(Object.values(ROUTE_SCOPE_MAP).flat()).not.toContain('quotes:write')
  })
})

describe('hasScope — legacy key behaviour preserved', () => {
  it('empty required scopes → always allowed', () => {
    expect(hasScope([], [])).toBe(true)
    expect(hasScope(undefined, [])).toBe(true)
  })

  it('legacy key with empty scopes array → full access (migration)', () => {
    expect(hasScope([], ['orders:write'])).toBe(true)
    expect(hasScope(undefined, ['orders:write'])).toBe(true)
  })

  it('sufficient scopes → allowed; missing → denied', () => {
    expect(hasScope(['orders:read', 'wallet:read'], ['orders:read'])).toBe(true)
    expect(hasScope(['esims:read'], ['esims:read', 'esims:write'])).toBe(false)
  })
})