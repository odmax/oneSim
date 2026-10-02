import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  findAdmin: vi.fn<() => Promise<any>>(),
  findUser: vi.fn<() => Promise<any>>(),
  createAdmin: vi.fn<() => Promise<any>>(),
  createUser: vi.fn<() => Promise<any>>(),
  updateAdmin: vi.fn<() => Promise<any>>(),
  updateUser: vi.fn<() => Promise<any>>(),
  countAdmin: vi.fn<() => Promise<any>>(),
  audit: vi.fn<() => Promise<any>>(),
  transaction: vi.fn<() => Promise<any>>(),
  revalidate: vi.fn(),
}))

const txClient = () => ({
  user: { findUnique: mocks.findUser, create: mocks.createUser, update: mocks.updateUser },
  internalAdmin: { findUnique: mocks.findAdmin, count: mocks.countAdmin, create: mocks.createAdmin, update: mocks.updateAdmin },
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    internalAdmin: { findUnique: mocks.findAdmin, count: mocks.countAdmin, update: mocks.updateAdmin, create: mocks.createAdmin },
    user: { findUnique: mocks.findUser, create: mocks.createUser, update: mocks.updateUser },
    auditLog: { create: mocks.audit },
    $transaction: mocks.transaction,
  },
}))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { const e = new Error(String(url)); (e as any).digest = 'NEXT_REDIRECT:' + String(url); throw e } }))
vi.mock('bcryptjs', () => {
  const hash = vi.fn().mockResolvedValue('hashed-password')
  const compare = vi.fn()
  return { default: { hash, compare }, hash, compare }
})

import { createAdminUser, updateAdminUser, toggleAdminStatus, deactivateAdminUser } from './admin-users'

const actorSuperAdmin = { id: 'actor-admin', userId: 'actor-user', role: 'SUPER_ADMIN', isActive: true, permissions: [] }
const actorPlainAdmin = { id: 'actor-admin', userId: 'actor-user', role: 'ADMIN', isActive: true, permissions: [] }

/** Interactive transaction runs the closure with the tx client; array form resolves as Promise.all. */
function runTransaction(anyArg: any): Promise<any> {
  if (Array.isArray(anyArg)) return Promise.all(anyArg)
  return anyArg(txClient())
}

function form(values: Record<string, string | boolean>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'boolean') { if (v) fd.set(k, 'on') }
    else fd.set(k, v)
  }
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transaction.mockImplementation(runTransaction)
  mocks.session.mockResolvedValue({ user: { id: 'actor-user', role: 'INTERNAL_ADMIN' } })
  mocks.findAdmin.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.userId === 'actor-user' ? actorSuperAdmin : null))
  mocks.createUser.mockResolvedValue({ id: 'user-1' })
  mocks.createAdmin.mockResolvedValue({ id: 'ia-1' })
  mocks.updateUser.mockImplementation(({ data }: any) => Promise.resolve({ id: 'user-1', ...data }))
  mocks.updateAdmin.mockImplementation(({ data }: any) => Promise.resolve({ id: 'ia-1', ...data }))
  mocks.countAdmin.mockResolvedValue(2)
  mocks.audit.mockResolvedValue({ id: 'log-1' })
  mocks.findUser.mockResolvedValue(null)
})

async function expectRedirect(promise: Promise<unknown>, contains: string) {
  await expect(promise).rejects.toThrow()
  await expect(promise).rejects.toMatchObject({ message: expect.stringContaining(contains) })
}

describe('createAdminUser — only SUPER_ADMIN can create', () => {
  it('rejects a non-SUPER_ADMIN acting admin before any user write', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorPlainAdmin : null))
    await expectRedirect(createAdminUser(form({ name: 'New', email: 'new@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin?error=unauthorized')
    expect(mocks.createUser).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('creates a brand-new admin and audits with the TARGET record id (actor stays in userId)', async () => {
    await expectRedirect(createAdminUser(form({ name: 'New', email: 'new@x.com', password: 'password123', role: 'ADMIN', permissions: '["VIEW_ORDERS"]' })), '/admin/users?success=Admin+user+created')
    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'new@x.com', role: 'INTERNAL_ADMIN' }) }))
    expect(mocks.createAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN', permissions: ['VIEW_ORDERS'] }) }))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_CREATED', entityId: 'ia-1', userId: 'actor-user' }) }))
  })

  it('a failing audit log does NOT fail the create (audit is best-effort non-fatal)', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit down'))
    await expectRedirect(createAdminUser(form({ name: 'New', email: 'new@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin/users?success=Admin+user+created')
    expect(mocks.createUser).toHaveBeenCalled()
    expect(mocks.createAdmin).toHaveBeenCalled()
  })
})

describe('createAdminUser — legacy same-email restoration', () => {
  it('reuses an inactive INTERNAL_ADMIN User with no InternalAdmin row and restores the record', async () => {
    mocks.findUser.mockResolvedValue({ id: 'legacy-user', email: 'old@x.com', name: 'Old', role: 'INTERNAL_ADMIN', isActive: false })
    await expectRedirect(createAdminUser(form({ name: 'Restored', email: 'old@x.com', password: 'password123', role: 'CEO', permissions: '[]' })), '/admin/users?success=Admin+account+restored')
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'legacy-user' }, data: expect.objectContaining({ name: 'Restored', isActive: true }) }))
    expect(mocks.createAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'legacy-user', role: 'CEO' }) }))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_RESTORED', entityId: 'ia-1', userId: 'actor-user' }) }))
  })

  it('rejects a BUSINESS_USER email collision and never converts the account', async () => {
    mocks.findUser.mockResolvedValue({ id: 'biz', email: 'biz@x.com', role: 'BUSINESS_USER', isActive: true })
    await expectRedirect(createAdminUser(form({ name: 'X', email: 'biz@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin/users/new?error=Email+already+in+use')
    expect(mocks.createUser).not.toHaveBeenCalled()
    expect(mocks.createAdmin).not.toHaveBeenCalled()
  })

  it('rejects an active INTERNAL_ADMIN duplicate', async () => {
    mocks.findUser.mockResolvedValue({ id: 'active', email: 'a@x.com', role: 'INTERNAL_ADMIN', isActive: true })
    await expectRedirect(createAdminUser(form({ name: 'X', email: 'a@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin/users/new?error=Email+already+in+use')
    expect(mocks.createUser).not.toHaveBeenCalled()
    expect(mocks.createAdmin).not.toHaveBeenCalled()
  })

  it('rejects an inactive INTERNAL_ADMIN that still has an InternalAdmin row', async () => {
    mocks.findUser.mockResolvedValue({ id: 'had-admin', email: 'h@x.com', role: 'INTERNAL_ADMIN', isActive: false })
    mocks.findAdmin.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.userId === 'actor-user' ? actorSuperAdmin : where?.userId ? { id: 'old-ia', userId: 'had-admin' } : null))
    await expectRedirect(createAdminUser(form({ name: 'X', email: 'h@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin/users/new?error=Email+already+in+use')
    expect(mocks.createAdmin).not.toHaveBeenCalled()
  })

  it('handles a concurrent P2002 duplicate-email race with a clear error', async () => {
    mocks.createUser.mockRejectedValue({ code: 'P2002', message: 'Unique constraint' })
    await expectRedirect(createAdminUser(form({ name: 'X', email: 'race@x.com', password: 'password123', role: 'ADMIN', permissions: '[]' })), '/admin/users/new?error=Email%20already%20in%20use')
  })
})

describe('updateAdminUser — role/permissions/status edits', () => {
  beforeEach(() => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-ia', userId: 'target-user', role: 'ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'T', email: 't@x.com' } }))
  })

  it('rejects a non-SUPER_ADMIN actor before any write', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorPlainAdmin : null))
    await expectRedirect(updateAdminUser('target-ia', form({ role: 'ADMIN', isActive: true, permissions: '["VIEW_ORDERS"]' })), '/admin?error=unauthorized')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('validates permission ids server-side (arbitrary strings dropped) and saves the result', async () => {
    await expectRedirect(
      updateAdminUser('target-ia', form({ role: 'ADMIN', isActive: true, permissions: '["VIEW_ORDERS","MANAGE_EVERYTHING","VIEW_ESIMS"]' })),
      '/admin/users?success=Admin+user+updated',
    )
    expect(mocks.updateAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ permissions: ['VIEW_ORDERS', 'VIEW_ESIMS'], role: 'ADMIN' }) }))
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_UPDATED' }) }))
  })

  it('prevents self-demotion', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'actor-admin', userId: 'actor-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'actor-user', name: 'Self', email: 's@x.com' } }))
    await expectRedirect(updateAdminUser('actor-admin', form({ role: 'ADMIN', isActive: true, permissions: '["VIEW_ORDERS"]' })), 'Cannot+demote+or+deactivate+yourself')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
  })

  it('protects the last active SUPER_ADMIN from demotion', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-super', userId: 'target-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'S', email: 's@x.com' } }))
    mocks.countAdmin.mockResolvedValue(1)
    await expectRedirect(updateAdminUser('target-super', form({ role: 'ADMIN', isActive: true, permissions: '["VIEW_ORDERS"]' })), 'Cannot+remove+last+SUPER_ADMIN')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
  })

  it('fails safe on a serialization conflict (P2034) without removing the last SUPER_ADMIN', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-super', userId: 'target-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'S', email: 's@x.com' } }))
    mocks.transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2034' }))
    await expectRedirect(updateAdminUser('target-super', form({ role: 'ADMIN', isActive: false, permissions: '["VIEW_ORDERS"]' })), 'Another%20admin%20change%20is%20in%20progress')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('preserves an explicit EMPTY permission array ([]) on save instead of role defaults', async () => {
    await expectRedirect(
      updateAdminUser('target-ia', form({ role: 'ADMIN', isActive: true, permissions: '[]' })),
      '/admin/users?success=Admin+user+updated',
    )
    expect(mocks.updateAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ permissions: [], role: 'ADMIN' }) }))
  })

  it('role defaults apply ONLY to null stored permissions, never to an explicit []', async () => {
    // The target has an explicit empty stored array; saving without changing must NOT expand to defaults.
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-ia', userId: 'target-user', role: 'SUPPORT_AGENT', isActive: true, permissions: [], user: { id: 'target-user', name: 'T', email: 't@x.com' } }))
    await expectRedirect(
      updateAdminUser('target-ia', form({ role: 'SUPPORT_AGENT', isActive: true, permissions: '[]' })),
      '/admin/users?success=Admin+user+updated',
    )
    expect(mocks.updateAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ permissions: [], role: 'SUPPORT_AGENT' }) }))
  })

  it('a failing audit log does NOT fail the update (audit is best-effort non-fatal)', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit down'))
    await expectRedirect(updateAdminUser('target-ia', form({ role: 'ADMIN', isActive: true, permissions: '["VIEW_ORDERS"]' })), '/admin/users?success=Admin+user+updated')
    expect(mocks.updateAdmin).toHaveBeenCalled()
  })
})

describe('deactivateAdminUser — audited deactivation (keeps both rows)', () => {
  beforeEach(() => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-ia', userId: 'target-user', role: 'ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'T', email: 't@x.com' } }))
  })

  it('sets BOTH User and InternalAdmin inactive and does NOT delete either row', async () => {
    await expectRedirect(deactivateAdminUser('target-ia'), '/admin/users?success=Admin+account+deactivated')
    expect(mocks.updateAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }))
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_DEACTIVATED' }) }))
  })

  it('prevents self-deactivation and protecting the last SUPER_ADMIN', async () => {
    await expectRedirect(deactivateAdminUser('actor-admin'), '/admin/users?error=Cannot+deactivate+yourself')
    mocks.countAdmin.mockResolvedValue(1)
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-super', userId: 'target-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'S', email: 's@x.com' } }))
    await expectRedirect(deactivateAdminUser('target-super'), '/admin/users?error=Cannot+deactivate+last+SUPER_ADMIN')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
  })

  it('fails safe on a serialization conflict (P2034) for the last SUPER_ADMIN', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-super', userId: 'target-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'S', email: 's@x.com' } }))
    mocks.transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2034' }))
    await expectRedirect(deactivateAdminUser('target-super'), 'Another%20admin%20change%20is%20in%20progress')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('denies a non-SUPER_ADMIN actor', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorPlainAdmin : null))
    await expectRedirect(deactivateAdminUser('target-ia'), '/admin?error=unauthorized')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
  })
})

describe('toggleAdminStatus — reactivation is possible after deactivation', () => {
  beforeEach(() => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-ia', userId: 'target-user', role: 'ADMIN', isActive: false, permissions: null, user: { id: 'target-user', name: 'T', email: 't@x.com' } }))
  })

  it('reactivates by setting BOTH flags and audits', async () => {
    await expectRedirect(toggleAdminStatus('target-ia'), '/admin/users?success=Admin+reactivated')
    expect(mocks.updateAdmin).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }))
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_REACTIVATED' }) }))
  })

  it('fails safe on a serialization conflict (P2034) when suspending the last SUPER_ADMIN', async () => {
    mocks.findAdmin.mockImplementation(({ where }: any) => Promise.resolve(where?.userId ? actorSuperAdmin : { id: 'target-super', userId: 'target-user', role: 'SUPER_ADMIN', isActive: true, permissions: null, user: { id: 'target-user', name: 'S', email: 's@x.com' } }))
    mocks.transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2034' }))
    await expectRedirect(toggleAdminStatus('target-super'), 'Another%20admin%20change%20is%20in%20progress')
    expect(mocks.updateAdmin).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})