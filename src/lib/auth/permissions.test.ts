import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS } from '@/lib/auth/admin-permissions'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  admin: vi.fn<() => Promise<any>>(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { internalAdmin: { findUnique: mocks.admin } },
}))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

import {
  ALL_ADMIN_PERMISSION_IDS,
  CAPABILITY_PERMISSIONS,
  Permissions,
  capabilityToPermissionIds,
  effectivePermissions,
  checkPermission,
} from '@/lib/auth/permissions'

const VALID_IDS = ALL_ADMIN_PERMISSION_IDS as readonly string[]

describe('effectivePermissions — DB permission resolution', () => {
  it('SUPER_ADMIN is always fully privileged regardless of stored value', () => {
    expect(effectivePermissions('SUPER_ADMIN', ['VIEW_ORDERS'])).toEqual(ALL_ADMIN_PERMISSION_IDS)
    expect(effectivePermissions('SUPER_ADMIN', null)).toEqual(ALL_ADMIN_PERMISSION_IDS)
  })

  it('legacy null permissions fall back to the role defaults for every role', () => {
    for (const role of Object.keys(DEFAULT_PERMISSIONS)) {
      const got = effectivePermissions(role, null)
      expect(got).toEqual(DEFAULT_PERMISSIONS[role].filter((p) => VALID_IDS.includes(p)))
      expect(got.length).toBeGreaterThan(0)
    }
  })

  it('an explicit array is honored verbatim, including an empty manual override', () => {
    expect(effectivePermissions('ADMIN', [])).toEqual([])
    expect(effectivePermissions('SUPPORT_AGENT', ['VIEW_ORDERS', 'NOT_A_REAL_PERM'])).toEqual(['VIEW_ORDERS'])
  })

  it('malformed non-null stored values (object/string/number/boolean) resolve to [] — no role defaults', () => {
    expect(effectivePermissions('SALES_TEAM', { foo: 'VIEW_ORDERS' })).toEqual([])
    expect(effectivePermissions('SALES_TEAM', 'VIEW_ORDERS')).toEqual([])
    expect(effectivePermissions('SALES_TEAM', 42)).toEqual([])
    expect(effectivePermissions('SALES_TEAM', true)).toEqual([])
    // Even a NON-EMPTY array with only junk yields [] (never defaults).
    expect(effectivePermissions('SALES_TEAM', ['NOT_A_REAL_PERM'])).toEqual([])
  })

  it('role defaults apply ONLY to null/undefined, never to malformed values', () => {
    const salesDefaults = DEFAULT_PERMISSIONS.SALES_TEAM.filter(p => VALID_IDS.includes(p))
    expect(effectivePermissions('SALES_TEAM', null)).toEqual(salesDefaults)
    expect(effectivePermissions('SALES_TEAM', undefined)).toEqual(salesDefaults)
    expect(effectivePermissions('SALES_TEAM', [])).toEqual([])
  })

  it('arbitrary permission strings are never trusted', () => {
    const got = effectivePermissions('ADMIN', ['VIEW_ESIMS', 'MANAGE_EVERYTHING', '  ', 42])
    expect(got).toEqual(['VIEW_ESIMS'])
  })
})

describe('capability mapping — Permissions keys resolve to valid ADMIN_PERMISSION ids', () => {
  it('every capability maps onto one or more existing permission ids', () => {
    for (const key of Object.keys(Permissions)) {
      const ids = capabilityToPermissionIds(CAPABILITY_PERMISSIONS[key])
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(VALID_IDS).toContain(id)
    }
  })

  it('permission-id passthrough and unknown values', () => {
    expect(capabilityToPermissionIds('MANAGE_ORDERS')).toEqual(['MANAGE_ORDERS'])
    expect(capabilityToPermissionIds(['VIEW_ESIMS', 'VIEW_ANALYTICS'])).toEqual(['VIEW_ESIMS', 'VIEW_ANALYTICS'])
    expect(capabilityToPermissionIds('MADE_UP_KEY')).toEqual([])
  })

  it('all DEFAULT_PERMISSIONS entries contain only valid permission ids', () => {
    for (const [role, ids] of Object.entries(DEFAULT_PERMISSIONS)) {
      for (const id of ids) expect(VALID_IDS).toContain(id)
      expect(effectivePermissions(role, ids)).toEqual(ids)
    }
  })
})

describe('checkPermission — DB-backed, effective on the next request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.mockResolvedValue({ user: { id: 'admin-user-1', role: 'INTERNAL_ADMIN' } })
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_ORDERS', 'VIEW_ESIMS'] })
  })

  it('grants from the CURRENT database row, not the session claim', async () => {
    expect((await checkPermission(Permissions.VIEW_ORDERS)).allowed).toBe(true)
    expect((await checkPermission(Permissions.MANAGE_ADMINS)).allowed).toBe(false)
  })

  it('revoking a permission takes effect on the next request (stale session cannot retain access)', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_ORDERS'] })
    expect((await checkPermission(Permissions.VIEW_ORDERS)).allowed).toBe(true)
    // Permission removed in the DB on the next request:
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: [] })
    expect((await checkPermission(Permissions.VIEW_ORDERS)).allowed).toBe(false)
  })

  it('a deactivated admin is denied even if a stale session claims INTERNAL_ADMIN', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: false, permissions: null })
    expect((await checkPermission(Permissions.MANAGE_ADMINS)).allowed).toBe(false)
  })

  it('a missing admin row denies access', async () => {
    mocks.admin.mockResolvedValue(null)
    expect((await checkPermission(Permissions.MANAGE_ADMINS)).allowed).toBe(false)
  })

  it('a SUPER_ADMIN row gains every capability regardless of stored permission list', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: true, permissions: ['VIEW_ORDERS'] })
    expect((await checkPermission(Permissions.MANAGE_USERS)).allowed).toBe(true)
    expect((await checkPermission(Permissions.MANAGE_FINANCE)).allowed).toBe(true)
  })
})

describe('ADMIN_PERMISSIONS approval set', () => {
  it('the checkbox catalog has unique ids and non-empty groups', () => {
    const ids = ADMIN_PERMISSIONS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of ADMIN_PERMISSIONS) expect(p.group.length).toBeGreaterThan(0)
  })
})
describe('capability mapping — single granular checkbox semantics (no require-both)', () => {
  it('VIEW_LOGS is a single-id alias and never requires BOTH audit and API log boxes', () => {
    expect(capabilityToPermissionIds(Permissions.VIEW_LOGS)).toEqual(['VIEW_AUDIT_LOGS'])
  })
  it('MANAGE_FINANCE is a single-id alias (wallets) and never requires both invoice + wallet boxes', () => {
    expect(capabilityToPermissionIds(Permissions.MANAGE_FINANCE)).toEqual(['MANAGE_WALLETS'])
  })
  it('the granular capabilities each resolve to exactly one checkbox id', () => {
    for (const k of ['VIEW_AUDIT_LOGS', 'VIEW_API_LOGS', 'MANAGE_INVOICES', 'MANAGE_WALLETS', 'VIEW_SUPPORT']) {
      expect(capabilityToPermissionIds(Permissions[k])).toEqual([k])
    }
  })
  it('VIEW_SUPPORT is part of the checkbox vocabulary and the support defaults', () => {
    const ids = ADMIN_PERMISSIONS.map((x) => x.id)
    expect(ids).toContain('VIEW_SUPPORT')
    for (const role of ['SUPPORT_MANAGER', 'SUPPORT_AGENT', 'OPERATIONS_MANAGER']) {
      expect(DEFAULT_PERMISSIONS[role]).toContain('VIEW_SUPPORT')
    }
  })
  it('admin with only VIEW_API_LOGS cannot access the audit-logs capability (VIEW_AUDIT_LOGS)', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_API_LOGS'] })
    expect((await checkPermission(Permissions.VIEW_API_LOGS as any)).allowed).toBe(true)
    expect((await checkPermission(Permissions.VIEW_AUDIT_LOGS as any)).allowed).toBe(false)
  })
  it('SUPER_ADMIN is allowed VIEW_SUPPORT regardless of stored list', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: true, permissions: null })
    expect((await checkPermission(Permissions.VIEW_SUPPORT as any)).allowed).toBe(true)
  })
})