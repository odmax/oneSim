export const ADMIN_PERMISSIONS = [
  { id: 'MANAGE_BUSINESSES', label: 'Manage Businesses', group: 'Businesses' },
  { id: 'VIEW_BUSINESSES', label: 'View Businesses', group: 'Businesses' },
  { id: 'MANAGE_PROVIDERS', label: 'Manage Providers', group: 'Providers' },
  { id: 'VIEW_PROVIDERS', label: 'View Providers', group: 'Providers' },
  { id: 'MANAGE_PACKAGES', label: 'Manage Packages', group: 'Packages' },
  { id: 'VIEW_PACKAGES', label: 'View Packages', group: 'Packages' },
  { id: 'MANAGE_PRICING', label: 'Manage Pricing', group: 'Pricing' },
  { id: 'VIEW_PRICING', label: 'View Pricing', group: 'Pricing' },
  { id: 'MANAGE_ORDERS', label: 'Manage Orders', group: 'Orders' },
  { id: 'VIEW_ORDERS', label: 'View Orders', group: 'Orders' },
  { id: 'MANAGE_ESIMS', label: 'Manage eSIMs', group: 'eSIMs' },
  { id: 'VIEW_ESIMS', label: 'View eSIMs', group: 'eSIMs' },
  { id: 'MANAGE_INVOICES', label: 'Manage Invoices', group: 'Finance' },
  { id: 'VIEW_INVOICES', label: 'View Invoices', group: 'Finance' },
  { id: 'MANAGE_WALLETS', label: 'Manage Wallets', group: 'Finance' },
  { id: 'VIEW_ANALYTICS', label: 'View Analytics', group: 'Analytics' },
  { id: 'VIEW_AUDIT_LOGS', label: 'View Audit Logs', group: 'Monitoring' },
  { id: 'VIEW_API_LOGS', label: 'View API Logs', group: 'Monitoring' },
  { id: 'MANAGE_SETTINGS', label: 'Manage Settings', group: 'System' },
  { id: 'MANAGE_ADMIN_USERS', label: 'Manage Admin Users', group: 'System' },
] as const

export type AdminPermissionId = (typeof ADMIN_PERMISSIONS)[number]['id']

export const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  CEO: ADMIN_PERMISSIONS.map(p => p.id),
  SUPER_ADMIN: ADMIN_PERMISSIONS.map(p => p.id),
  ADMIN: ADMIN_PERMISSIONS.map(p => p.id),
  SALES_TEAM: ['VIEW_BUSINESSES', 'VIEW_ORDERS', 'VIEW_ESIMS', 'VIEW_ANALYTICS', 'VIEW_INVOICES'],
  OPERATIONS_MANAGER: ['MANAGE_BUSINESSES', 'VIEW_BUSINESSES', 'MANAGE_PROVIDERS', 'VIEW_PROVIDERS', 'MANAGE_PACKAGES', 'VIEW_PACKAGES', 'MANAGE_PRICING', 'VIEW_PRICING', 'MANAGE_ORDERS', 'VIEW_ORDERS', 'MANAGE_ESIMS', 'VIEW_ESIMS', 'MANAGE_WALLETS', 'VIEW_ANALYTICS', 'VIEW_AUDIT_LOGS', 'VIEW_API_LOGS'],
  PRODUCT_MANAGER: ['VIEW_BUSINESSES', 'VIEW_PROVIDERS', 'MANAGE_PACKAGES', 'VIEW_PACKAGES', 'MANAGE_PRICING', 'VIEW_PRICING', 'VIEW_ORDERS', 'VIEW_ESIMS', 'VIEW_ANALYTICS'],
  SUPPORT_MANAGER: ['VIEW_BUSINESSES', 'VIEW_ORDERS', 'MANAGE_ORDERS', 'VIEW_ESIMS', 'MANAGE_ESIMS', 'VIEW_AUDIT_LOGS'],
  SUPPORT_AGENT: ['VIEW_BUSINESSES', 'VIEW_ORDERS', 'VIEW_ESIMS'],
  FINANCE_MANAGER: ['VIEW_BUSINESSES', 'VIEW_INVOICES', 'MANAGE_INVOICES', 'VIEW_ORDERS', 'MANAGE_WALLETS', 'VIEW_ANALYTICS'],
  ANALYTICS_MANAGER: ['VIEW_ANALYTICS', 'VIEW_ORDERS', 'VIEW_BUSINESSES'],
  READ_ONLY: ['VIEW_BUSINESSES', 'VIEW_PACKAGES', 'VIEW_ORDERS', 'VIEW_ESIMS', 'VIEW_ANALYTICS'],
}
