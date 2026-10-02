import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { InternalAdminRole } from '@prisma/client'
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, type AdminPermissionId } from '@/lib/auth/admin-permissions'

export type RolePermission = InternalAdminRole

/**
 * The full, canonical permission-id set (the checkbox vocabulary).
 */
export const ALL_ADMIN_PERMISSION_IDS: readonly AdminPermissionId[] = ADMIN_PERMISSIONS.map((p) => p.id)

const ALL_ADMIN_PERMISSION_IDS_SET: ReadonlySet<string> = new Set(ALL_ADMIN_PERMISSION_IDS as readonly string[])

/**
 * Capability → existing ADMIN_PERMISSIONS ids.
 *
 * Every capability a page/action/sidebar was previously gated on via the old
 * role arrays now maps onto the stored permission vocabulary, so enforcement is
 * backed by the CURRENT database InternalAdmin.role/permissions. Super Admin is
 * always fully privileged regardless (see effectivePermissions). Roles with
 * null permissions fall back to DEFAULT_PERMISSIONS[role].
 */
export const CAPABILITY_PERMISSIONS: Record<string, readonly AdminPermissionId[]> = {
  VIEW_ANALYTICS: ['VIEW_ANALYTICS'],
  MANAGE_PRODUCTS: ['MANAGE_PACKAGES'],
  MANAGE_PROVIDERS: ['MANAGE_PROVIDERS'],
  MANAGE_PRICING: ['MANAGE_PRICING'],
  MANAGE_ORDERS: ['MANAGE_ORDERS'],
  MANAGE_BUSINESSES: ['MANAGE_BUSINESSES'],
  MANAGE_ADMINS: ['MANAGE_ADMIN_USERS'],
  MANAGE_USERS: ['MANAGE_ADMIN_USERS'],
  // Backward-compatible ALIAS, single id each (audit and API logs are distinct
  // page-level capabilities below; no capability requires two checkboxes).
  VIEW_LOGS: ['VIEW_AUDIT_LOGS'],
  MANAGE_SETTINGS: ['MANAGE_SETTINGS'],
  MANAGE_JOBS: ['MANAGE_SETTINGS'],
  VIEW_ORDERS: ['VIEW_ORDERS'],
  VIEW_ESIMS: ['VIEW_ESIMS'],
  MANAGE_FINANCE: ['MANAGE_WALLETS'],
  VIEW_FINANCE: ['VIEW_INVOICES'],
  VIEW_PACKAGES: ['VIEW_PACKAGES'],
  MANAGE_PACKAGES: ['MANAGE_PACKAGES'],
  MANAGE_ESIMS: ['MANAGE_ESIMS'],
  VIEW_BUSINESSES: ['VIEW_BUSINESSES'],
  VIEW_PROVIDERS: ['VIEW_PROVIDERS'],
  VIEW_PRICING: ['VIEW_PRICING'],
  VIEW_INVOICES: ['VIEW_INVOICES'],
  MANAGE_INVOICES: ['MANAGE_INVOICES'],
  VIEW_AUDIT_LOGS: ['VIEW_AUDIT_LOGS'],
  VIEW_API_LOGS: ['VIEW_API_LOGS'],
  MANAGE_WALLETS: ['MANAGE_WALLETS'],
  VIEW_SUPPORT: ['VIEW_SUPPORT'],
}

/**
 * Capability constants kept under the historical `Permissions.X` names so the
 * ~60 existing pages/actions/sidebar call sites continue to reference the same
 * symbols; the VALUES are now stored-permission ids instead of role arrays.
 */
export const Permissions: Record<string, readonly AdminPermissionId[]> = CAPABILITY_PERMISSIONS

export type Capability = AdminPermissionId | readonly AdminPermissionId[] | string

/* Kept for backward compatibility with any role-hierarchy consumers; NOT the
 * enforcement path. Enforcement uses the DB-backed capability checks below. */
const roleHierarchy: Record<InternalAdminRole, number> = {
  READ_ONLY: 0,
  SUPPORT_AGENT: 1,
  SALES_TEAM: 10,
  SUPPORT_MANAGER: 20,
  ANALYTICS_MANAGER: 30,
  FINANCE_MANAGER: 35,
  PRODUCT_MANAGER: 40,
  OPERATIONS_MANAGER: 80,
  ADMIN: 90,
  CEO: 100,
  SUPER_ADMIN: 100,
}

export function hasPermission(userRole: InternalAdminRole | null, requiredRole: InternalAdminRole): boolean {
  if (!userRole) return false
  return (roleHierarchy[userRole] ?? 0) >= (roleHierarchy[requiredRole] ?? 0)
}

export function hasAnyPermission(userRole: InternalAdminRole | null, requiredRoles: InternalAdminRole[]): boolean {
  if (!userRole) return false
  return requiredRoles.some((r) => hasPermission(userRole, r))
}

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === 'SUPER_ADMIN'
}

function isValidPermissionId(value: unknown): value is AdminPermissionId {
  return typeof value === 'string' && ALL_ADMIN_PERMISSION_IDS_SET.has(value)
}

/**
 * Effective permissions for a stored admin row (pure, testable):
 *  - SUPER_ADMIN is always fully privileged (never reducible);
 *  - role defaults apply ONLY when the stored value is null/undefined (legacy
 *    records) — an explicit array, even an empty one, is a manual override and
 *    is honored verbatim;
 *  - ANY other non-null stored value (object, string, number) is malformed and
 *    yields [] — defaults are never applied to malformed input, so a corrupt
 *    record degrades to least privilege.
 */
export function effectivePermissions(
  role: string | null | undefined,
  storedPermissions: unknown,
): AdminPermissionId[] {
  if (isSuperAdminRole(role)) return [...ALL_ADMIN_PERMISSION_IDS]
  if (storedPermissions === null || storedPermissions === undefined) {
    const fallback = DEFAULT_PERMISSIONS[String(role || '').toUpperCase()] || []
    return fallback.filter(isValidPermissionId)
  }
  if (!Array.isArray(storedPermissions)) return []
  return storedPermissions.filter(isValidPermissionId)
}

/** Resolve a capability (permission id or capability key) to canonical ids. */
export function capabilityToPermissionIds(capability: Capability): AdminPermissionId[] {
  const values = (Array.isArray(capability) ? capability : [capability]) as string[]
  const out: AdminPermissionId[] = []
  for (const value of values) {
    const mapped = CAPABILITY_PERMISSIONS[value]
    if (mapped) out.push(...mapped)
    else if (isValidPermissionId(value)) out.push(value as AdminPermissionId)
  }
  return [...new Set(out)]
}

export interface AdminAccess {
  id: string
  role: InternalAdminRole
  isActive: boolean
  permissions: AdminPermissionId[]
}

/** Load the CURRENT Database admin access for a user (never the session claim).
 *  Returns null when the row is missing or deactivated. */
export async function loadAdminAccess(userId: string): Promise<AdminAccess | null> {
  const record = await prisma.internalAdmin.findUnique({
    where: { userId },
    select: { id: true, role: true, isActive: true, permissions: true },
  })
  if (!record || !record.isActive) return null
  return {
    id: record.id,
    role: record.role,
    isActive: true,
    permissions: effectivePermissions(record.role, record.permissions),
  }
}

export async function canAccessAdmin(userId: string | null | undefined, capability: Capability): Promise<boolean> {
  if (!userId) return false
  const access = await loadAdminAccess(userId)
  if (!access) return false
  const required = capabilityToPermissionIds(capability)
  if (required.length === 0) return false
  const granted = new Set(access.permissions as readonly string[])
  return required.every((id) => granted.has(id))
}

export interface PermissionCheck {
  allowed: boolean
  role: InternalAdminRole | null
}

/** DB-backed page/session check. Stale session role claims are ignored — the
 *  CURRENT database row decides, so revoked permissions take effect on the next
 *  request. */
export async function checkPermission(capability: Capability): Promise<PermissionCheck> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) {
    return { allowed: false, role: null }
  }
  const access = await loadAdminAccess(session.user.id)
  if (!access) return { allowed: false, role: null }
  return { allowed: await canAccessAdmin(session.user.id, capability), role: access.role }
}

/** DB-backed guard that redirects when the user cannot access the capability. */
export async function requirePermission(capability: Capability): Promise<Awaited<ReturnType<typeof getServerSession>>> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) {
    redirect('/login')
  }
  const allowed = await canAccessAdmin(session.user.id, capability)
  if (!allowed) redirect('/admin/unauthorized')
  return session
}

export async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }
  return session
}