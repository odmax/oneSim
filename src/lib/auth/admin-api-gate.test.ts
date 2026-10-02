import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  admin: vi.fn<() => Promise<any>>(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { internalAdmin: { findUnique: mocks.admin } },
}))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { id: 'u1', role: 'INTERNAL_ADMIN', internalAdminRole: 'ADMIN' } })
  mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_PACKAGES', 'VIEW_ESIMS'] })
})

describe('adminApiAccess — DB-backed capability gate for admin APIs', () => {
  it('grants when the current DB permissions include the capability (stale session claim irrelevant)', async () => {
    const gate = await adminApiAccess(Permissions.VIEW_PACKAGES)
    expect(gate.allowed).toBe(true)
  })

  it('revokes on the NEXT request when the permission is removed in the database', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_PACKAGES'] })
    expect((await adminApiAccess(Permissions.VIEW_PACKAGES)).allowed).toBe(true)
    // DB change on the next request: permission removed, session claim still ADMIN.
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: [] })
    const gate = await adminApiAccess(Permissions.VIEW_PACKAGES)
    expect(gate.allowed).toBe(false)
    expect(gate.denied.status).toBe(403)
  })

  it('read permission does NOT grant the mutation permission', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_PACKAGES'] })
    expect((await adminApiAccess(Permissions.VIEW_PACKAGES)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.MANAGE_PACKAGES)).allowed).toBe(false)
    // VIEW_ESIMS is not MANAGE_ESIMS.
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_ESIMS'] })
    expect((await adminApiAccess(Permissions.VIEW_ESIMS)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.MANAGE_ESIMS)).allowed).toBe(false)
  })

  it('a deactivated or missing admin row is denied', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: false, permissions: null })
    expect((await adminApiAccess(Permissions.VIEW_PACKAGES)).allowed).toBe(false)
    mocks.admin.mockResolvedValue(null)
    expect((await adminApiAccess(Permissions.VIEW_PACKAGES)).allowed).toBe(false)
  })

  it('SUPER_ADMIN remains fully privileged regardless of the stored permission list', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: true, permissions: ['VIEW_ESIMS'] })
    expect((await adminApiAccess(Permissions.MANAGE_PACKAGES)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.MANAGE_ADMINS)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.VIEW_INVOICES)).allowed).toBe(true)
  })

  it('a non-administrator session is rejected with 401', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'b1', role: 'BUSINESS_USER', businessId: 'biz-1' } })
    const gate = await adminApiAccess(Permissions.VIEW_ESIMS)
    expect(gate.allowed).toBe(false)
    expect(gate.denied.status).toBe(401)
  })

  it('an unauthenticated request is rejected', async () => {
    mocks.session.mockResolvedValue(null)
    const gate = await adminApiAccess(Permissions.VIEW_ESIMS)
    expect(gate.allowed).toBe(false)
    expect(gate.denied.status).toBe(401)
  })
})
describe('adminApiAccess — granular checkbox independence and VIEW_SUPPORT', () => {
  it('VIEW_API_LOGS grants the API-logs capability and NOT the audit-logs capability', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_API_LOGS'] })
    expect((await adminApiAccess(Permissions.VIEW_API_LOGS)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)).allowed).toBe(false)
  })
  it('VIEW_SUPPORT grants the support capability and nothing else', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_SUPPORT'] })
    expect((await adminApiAccess(Permissions.VIEW_SUPPORT)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.VIEW_ORDERS)).allowed).toBe(false)
  })
  it('MANAGE_WALLETS alone does not grant MANAGE_INVOICES (each box is independent)', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, permissions: ['MANAGE_WALLETS'] })
    expect((await adminApiAccess(Permissions.MANAGE_WALLETS)).allowed).toBe(true)
    expect((await adminApiAccess(Permissions.MANAGE_INVOICES)).allowed).toBe(false)
  })
  it('SUPER_ADMIN stays fully privileged on VIEW_SUPPORT', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: true, permissions: null })
    expect((await adminApiAccess(Permissions.VIEW_SUPPORT)).allowed).toBe(true)
  })
})