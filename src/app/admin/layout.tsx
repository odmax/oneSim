import Sidebar from '@/components/layout/sidebar';
import Header from '@/components/layout/header';
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { hasAnyPermission, Permissions } from '@/lib/auth/permissions'
import { InternalAdminRole } from '@prisma/client'

interface SidebarItemDef {
  title: string
  href: string
  sectionHeader?: boolean
  permission?: InternalAdminRole[]
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const role = session.user.internalAdminRole
  const can = (perm: InternalAdminRole[]) => hasAnyPermission(role, perm)

  const allItems: SidebarItemDef[] = [
    { title: 'Dashboard', href: '/admin/dashboard' },
    { title: 'Businesses', href: '/admin/businesses', permission: Permissions.MANAGE_BUSINESSES },
    { title: 'PROVIDERS & PRODUCTS', href: '#', sectionHeader: true },
    { title: 'Provider Management', href: '/admin/providers', permission: Permissions.MANAGE_PROVIDERS },
    { title: 'Package Rules', href: '/admin/package-rules', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'Provider Catalog', href: '/admin/provider-catalog', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'Catalog Health', href: '/admin/provider-catalog/health', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'Pipeline', href: '/admin/provider-catalog/pipeline', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'Catalog History', href: '/admin/provider-catalog/history', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'Product Catalog', href: '/admin/packages', permission: Permissions.MANAGE_PRODUCTS },
    { title: 'OPERATIONS', href: '#', sectionHeader: true },
    { title: 'Orders', href: '/admin/orders', permission: Permissions.VIEW_ORDERS },
    { title: 'eSIMs', href: '/admin/esims', permission: Permissions.VIEW_ESIMS },
    { title: 'Usage Analytics', href: '/admin/usage', permission: Permissions.VIEW_ANALYTICS },
    { title: 'Invoices', href: '/admin/invoices', permission: Permissions.VIEW_FINANCE },
    { title: 'Finance Dashboard', href: '/admin/finance', permission: Permissions.VIEW_FINANCE },
    { title: 'Credit Allocations', href: '/admin/wallet-topups', permission: Permissions.MANAGE_FINANCE },
    { title: 'MONITORING', href: '#', sectionHeader: true },
    { title: 'Analytics', href: '/admin/analytics', permission: Permissions.VIEW_ANALYTICS },
    { title: 'SIM Usage', href: '/admin/analytics/sim-usage', permission: Permissions.VIEW_ANALYTICS },
    { title: 'API Analytics', href: '/admin/api-analytics', permission: Permissions.VIEW_ANALYTICS },
    { title: 'Alerts & Events', href: '/admin/alerts', permission: Permissions.VIEW_ANALYTICS },
    { title: 'System Monitoring', href: '/admin/monitoring', permission: Permissions.VIEW_ANALYTICS },
    { title: 'Performance', href: '/admin/performance', permission: Permissions.VIEW_ANALYTICS },
    { title: 'Provider Health', href: '/admin/provider-health', permission: Permissions.MANAGE_PROVIDERS },
    { title: 'Support Queue', href: '/admin/support', permission: Permissions.VIEW_SUPPORT },
    { title: 'Audit Logs', href: '/admin/audit-logs', permission: Permissions.VIEW_LOGS },
    { title: 'API Logs', href: '/admin/api-logs', permission: Permissions.VIEW_LOGS },
    { title: 'Provider Webhooks', href: '/admin/provider-webhooks', permission: Permissions.MANAGE_PROVIDERS },
    { title: 'Webhook Monitoring', href: '/admin/webhook-monitoring', permission: Permissions.MANAGE_PROVIDERS },
    { title: 'Admin Users', href: '/admin/users', permission: Permissions.MANAGE_USERS },
    { title: 'SYSTEM', href: '#', sectionHeader: true },
    { title: 'Settings', href: '/admin/settings', permission: Permissions.MANAGE_SETTINGS },
    { title: 'Account', href: '/admin/account' },
  ]

  const sidebarItems = allItems
    .filter(item => !item.permission || can(item.permission))
    .map(({ title, href, sectionHeader }) => ({ title, href, sectionHeader }))

  return (
    <div className="flex h-screen">
      <Sidebar items={sidebarItems} portalName="ONESIM ADMIN" />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header title="OneSIM Admin Portal" />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
