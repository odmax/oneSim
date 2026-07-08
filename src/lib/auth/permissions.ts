import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { InternalAdminRole } from '@prisma/client'

export type RolePermission = InternalAdminRole

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
  const userLevel = roleHierarchy[userRole] ?? 0
  const requiredLevel = roleHierarchy[requiredRole] ?? 0
  return userLevel >= requiredLevel
}

export function hasAnyPermission(userRole: InternalAdminRole | null, requiredRoles: InternalAdminRole[]): boolean {
  if (!userRole) return false
  return requiredRoles.some(r => hasPermission(userRole, r))
}

export interface PermissionCheck {
  allowed: boolean
  role: InternalAdminRole | null
}

export async function checkPermission(requiredRoles: InternalAdminRole[]): Promise<PermissionCheck> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { allowed: false, role: null }
  }
  const role = session.user.internalAdminRole
  return { allowed: hasAnyPermission(role, requiredRoles), role }
}

export async function requirePermission(requiredRoles: InternalAdminRole[]) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }
  const role = session.user.internalAdminRole
  if (!hasAnyPermission(role, requiredRoles)) {
    redirect('/admin/unauthorized')
  }
  return session
}

export async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }
  return session
}

export const Permissions = {
  VIEW_ANALYTICS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.ANALYTICS_MANAGER, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SALES_TEAM],
  MANAGE_PRODUCTS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.PRODUCT_MANAGER, InternalAdminRole.OPERATIONS_MANAGER],
  MANAGE_PROVIDERS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER],
  MANAGE_PRICING: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.PRODUCT_MANAGER],
  MANAGE_ORDERS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SUPPORT_MANAGER, InternalAdminRole.SUPPORT_AGENT, InternalAdminRole.SALES_TEAM],
  MANAGE_BUSINESSES: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SALES_TEAM],
  MANAGE_ADMINS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO],
  VIEW_LOGS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SUPPORT_MANAGER],
  MANAGE_SETTINGS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO],
  MANAGE_JOBS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER],
  VIEW_ORDERS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SUPPORT_MANAGER, InternalAdminRole.SUPPORT_AGENT, InternalAdminRole.SALES_TEAM, InternalAdminRole.FINANCE_MANAGER, InternalAdminRole.ANALYTICS_MANAGER],
  VIEW_ESIMS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SUPPORT_MANAGER, InternalAdminRole.SUPPORT_AGENT, InternalAdminRole.SALES_TEAM, InternalAdminRole.FINANCE_MANAGER, InternalAdminRole.ANALYTICS_MANAGER],
  MANAGE_FINANCE: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.FINANCE_MANAGER],
  VIEW_FINANCE: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.FINANCE_MANAGER, InternalAdminRole.OPERATIONS_MANAGER, InternalAdminRole.SALES_TEAM],
  MANAGE_USERS: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO],
  VIEW_SUPPORT: [InternalAdminRole.SUPER_ADMIN, InternalAdminRole.ADMIN, InternalAdminRole.CEO, InternalAdminRole.SUPPORT_MANAGER, InternalAdminRole.SUPPORT_AGENT, InternalAdminRole.OPERATIONS_MANAGER],
}
