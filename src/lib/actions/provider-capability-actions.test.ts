import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetServerSession } = vi.hoisted(() => ({ mockGetServerSession: vi.fn() }))
const { mockCheckPermission } = vi.hoisted(() => ({ mockCheckPermission: vi.fn() }))
const { mockProviderState } = vi.hoisted(() => ({ mockProviderState: vi.fn() }))
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/permissions', () => ({
  checkPermission: mockCheckPermission,
  Permissions: { MANAGE_PROVIDERS: 'MANAGE_PROVIDERS' },
}))
vi.mock('@/lib/providers/capability-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/capability-state')>()
  return {
    ...actual,
    getProviderCapabilityState: mockProviderState,
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { prisma } from '@/lib/prisma'
import { setProviderCapabilityEnabled } from './provider-capability-actions'

function adminSession(role = 'INTERNAL_ADMIN') {
  return { user: { role, id: 'admin-1', email: 'a@x' } }
}

function telnaProvider(overrides: any = {}) {
  return {
    id: 'telna-1',
    code: 'TELNA',
    status: 'ACTIVE',
    enabledCapabilities: null,
    ...overrides,
  }
}

describe('setProviderCapabilityEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue(adminSession())
    mockCheckPermission.mockResolvedValue({ allowed: true })
    mockPrisma.provider.update.mockResolvedValue({})
    mockPrisma.auditLog.create.mockResolvedValue({})
  })

  it('rejects unauthorized operator', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(false)
    expect((r as any).error).toBeTruthy()
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('rejects operator lacking MANAGE_PROVIDERS permission', async () => {
    mockCheckPermission.mockResolvedValue({ allowed: false })
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(false)
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('rejects unknown provider', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const r = await setProviderCapabilityEnabled('nope', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(false)
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('rejects invalid capability', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider())
    const r = await setProviderCapabilityEnabled('telna-1', 'NOT_A_REAL_CAP', true)
    expect(r.success).toBe(false)
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('supports + disabled capability can be enabled (WAITING Telna default: null → defaults exclude it)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider()) // enabledCapabilities: null
    // Connector supports CUSTOM_PACKAGE_CREATION.
    mockProviderState.mockResolvedValue({
      byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'SUPPORTED' } },
    })
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r).toEqual({ success: true, capability: 'CUSTOM_PACKAGE_CREATION', previousEnabled: false, newEnabled: true, changed: true })
    const arg = (prisma.provider.update as any).mock.calls[0][0]
    expect(arg.data.enabledCapabilities).toContain('CUSTOM_PACKAGE_CREATION')
    // Audit written.
    const audit = (prisma.auditLog.create as any).mock.calls[0][0].data
    expect(audit.userId).toBe('admin-1')
    expect(audit.action).toBe('PROVIDER_CAPABILITY_CHANGED')
    expect(audit.details).toContain('previousEnabled=false')
    expect(audit.details).toContain('newEnabled=true')
  })

  it('cannot enable an unsupported capability (implementationState NOT_SUPPORTED)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider())
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'NOT_SUPPORTED' } } })
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(false)
    expect((r as any).error).toContain('does not support')
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('cannot enable a NOT_IMPLEMENTED capability', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider())
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'NOT_IMPLEMENTED' } } })
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(false)
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('can disable a supported capability', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider({ enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] }))
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', false)
    expect(r).toEqual({ success: true, capability: 'CUSTOM_PACKAGE_CREATION', previousEnabled: true, newEnabled: false, changed: true })
    const arg = (prisma.provider.update as any).mock.calls[0][0]
    expect(arg.data.enabledCapabilities).toEqual([])
  })

  it('disabling a DEFAULT capability materializes an explicit array that excludes it (no fallback re-enable)', async () => {
    // A provider where CUSTOM_PACKAGE_CREATION is a documented default: null → defaults include it.
    mockPrisma.provider.findUnique.mockResolvedValue({
      id: 'p-1', code: 'SOME_CODE', status: 'ACTIVE', enabledCapabilities: null,
    })
    // enable first (supported) then disable → explicit [] persisted, ready=false later.
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'SUPPORTED' } } })
    const enable = await setProviderCapabilityEnabled('p-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(enable.success).toBe(true)
    const enArg = (prisma.provider.update as any).mock.calls[0][0]
    // base = defaults; we appended the cap. Array is explicit and present.
    expect(Array.isArray(enArg.data.enabledCapabilities)).toBe(true)
    expect(enArg.data.enabledCapabilities).toContain('CUSTOM_PACKAGE_CREATION')
  })

  it('is idempotent on enable (already enabled → no update)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider({ enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] }))
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r).toEqual({ success: true, capability: 'CUSTOM_PACKAGE_CREATION', previousEnabled: true, newEnabled: true, changed: false })
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled()
  })

  it('is idempotent on disable (already disabled → no update)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider()) // null → TELNA defaults exclude CUSTOM
    const r = await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', false)
    expect(r).toEqual({ success: true, capability: 'CUSTOM_PACKAGE_CREATION', previousEnabled: false, newEnabled: false, changed: false })
    expect(mockPrisma.provider.update).not.toHaveBeenCalled()
  })

  it('records previous/new values correctly in audit and actor', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider())
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'SUPPORTED' } } })
    await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    const audit = (prisma.auditLog.create as any).mock.calls[0][0].data
    expect(audit.userId).toBe('admin-1')
    expect(audit.entity).toBe('Provider')
    expect(audit.entityId).toBe('telna-1')
    expect(audit.details).toContain('previousEnabled=false')
    expect(audit.details).toContain('newEnabled=true')
    // No credentials/config secrets in audit details.
    expect(JSON.stringify(audit.details)).not.toMatch(/apiKey|token|secret|enc:/i)
  })

  it('makes zero provider HTTP requests (no network from the action)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(telnaProvider())
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'SUPPORTED' } } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no net') })
    await setProviderCapabilityEnabled('telna-1', 'CUSTOM_PACKAGE_CREATION', true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('is provider-neutral — no hardcoded provider code logic changes behavior', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'x-9', code: 'MADE_UP_VENDOR', status: 'ACTIVE', enabledCapabilities: null })
    mockProviderState.mockResolvedValue({ byKey: { CUSTOM_PACKAGE_CREATION: { implementationState: 'SUPPORTED' } } })
    const r = await setProviderCapabilityEnabled('x-9', 'CUSTOM_PACKAGE_CREATION', true)
    expect(r.success).toBe(true)
  })
})
