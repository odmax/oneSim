import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  loadAccess: vi.fn<() => Promise<any>>(),
  redirect: vi.fn((url: string) => {
    const e = new Error(`NEXT_REDIRECT: ${url}`)
    ;(e as any).digest = 'NEXT_REDIRECT:' + String(url)
    throw e
  }),
  signOut: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }))
vi.mock('@/lib/auth/permissions', () => ({
  loadAdminAccess: mocks.loadAccess,
  capabilityToPermissionIds: (cap: unknown) => (cap ? [String(cap)] : []),
  Permissions: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock('@/components/layout/sidebar', () => ({ default: () => null }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))

import AdminLayout from '@/app/admin/layout'
import HomePage from '@/app/page'
import AdminAccessDeniedPage from '@/app/admin-access-denied/page'
import AdminAccessDeniedSignOut from '@/app/admin-access-denied/sign-out-button'
import LoginForm from '@/app/login/login-form'

const INTERNAL_ADMIN = { user: { id: 'u1', role: 'INTERNAL_ADMIN', internalAdminRole: 'ADMIN' } }
const ACTIVE_ACCESS = { id: 'a1', role: 'ADMIN', isActive: true, permissions: ['VIEW_ORDERS'] }

/** Depth-first search for an element whose rendered children equal `needle`. */
function containsChild(el: any, needle: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  if (el.children === needle) return true
  if (el.props) {
    const kids = el.props.children
    if (kids === needle) return true
    const arr = Array.isArray(kids) ? kids : [kids]
    for (const k of arr) {
      if (containsChild(k, needle)) return true
    }
  }
  return false
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue(INTERNAL_ADMIN)
  mocks.loadAccess.mockResolvedValue(ACTIVE_ACCESS)
  mocks.signOut.mockResolvedValue(undefined)
})

describe('deactivated/missing admin — behavior-level redirect flow', () => {
  it('AdminLayout redirects a stale INTERNAL_ADMIN session (missing DB access) to /admin-access-denied', async () => {
    mocks.session.mockResolvedValue(INTERNAL_ADMIN)
    mocks.loadAccess.mockResolvedValue(null) // row missing/deactivated
    await expect(AdminLayout({ children: 'secret' })).rejects.toThrow(
      'NEXT_REDIRECT: /admin-access-denied',
    )
  })

  it('AdminLayout denies a DEACTIVATED admin row the same way (never /login, never /admin/unauthorized)', async () => {
    // loadAdminAccess contracts to null for a deactivated/missing row.
    mocks.loadAccess.mockResolvedValue(null)
    await expect(AdminLayout({ children: 'secret' })).rejects.toThrow(
      'NEXT_REDIRECT: /admin-access-denied',
    )
  })

  it('AdminLayout renders children when the admin row has valid access', async () => {
    const el = await AdminLayout({ children: 'secret-content' })
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(containsChild(el, 'secret-content')).toBe(true)
  })

  it('the root page sends a stale INTERNAL_ADMIN session (no DB access) to /admin-access-denied', async () => {
    mocks.loadAccess.mockResolvedValue(null)
    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT: /admin-access-denied')
  })

  it('an active admin still reaches /admin/dashboard from the root page', async () => {
    mocks.loadAccess.mockResolvedValue(ACTIVE_ACCESS)
    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT: /admin/dashboard')
  })

  it('a BUSINESS_USER session still routes to /business/dashboard (preserved behavior)', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'b1', role: 'BUSINESS_USER', businessId: 'biz-1' } })
    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT: /business/dashboard')
    expect(mocks.loadAccess).not.toHaveBeenCalled()
  })

  it('an anonymous visitor sees the login form (no redirect) at the root', async () => {
    mocks.session.mockResolvedValue(null)
    const el = await HomePage().catch(() => null)
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(el && el.type).toBe(LoginForm)
  })
})

describe('external /admin-access-denied page — behavior', () => {
  it('renders the denial screen for an admin-claimed session (no redirect back into /admin)', async () => {
    mocks.session.mockResolvedValue(INTERNAL_ADMIN)
    const el = await AdminAccessDeniedPage()
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(el).toBeTruthy()
  })

  it('sends anonymous users to /login', async () => {
    mocks.session.mockResolvedValue(null)
    await expect(AdminAccessDeniedPage()).rejects.toThrow('NEXT_REDIRECT: /login')
  })

  it('provides a working sign-out action that signs out to /login', () => {
    const button = AdminAccessDeniedSignOut()
    expect(button).toBeTruthy()
    expect(button.type).toBe('button')
    // Trigger the exposed click handler directly (node env has no DOM).
    ;(button as any).props.onClick()
    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: '/login' })
  })
})

describe('structural guarantee — denial route stays outside the /admin layout', () => {
  it('/admin-access-denied page lives outside src/app/admin so it does not inherit AdminLayout', () => {
    const deniedPath = path.join(process.cwd(), 'src/app/admin-access-denied/page.tsx')
    expect(existsSync(deniedPath)).toBe(true)
    const segments = deniedPath.split(path.sep)
    const appIdx = segments.indexOf('app')
    expect(segments[appIdx + 1]).toBe('admin-access-denied')
    expect(segments[appIdx + 1]).not.toBe('admin')
  })
})