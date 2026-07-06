import Sidebar from '@/components/layout/sidebar';
import Header from '@/components/layout/header';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sidebarItems = [
    { title: 'Dashboard', href: '/admin/dashboard' },
    { title: 'Businesses', href: '/admin/businesses' },
    { title: 'PROVIDERS & PRODUCTS', href: '#', sectionHeader: true },
    { title: 'Provider Management', href: '/admin/providers' },
    { title: 'Package Rules', href: '/admin/package-rules' },
    { title: 'Provider Catalog', href: '/admin/provider-catalog' },
    { title: 'Catalog Health', href: '/admin/provider-catalog/health' },
    { title: 'Catalog History', href: '/admin/provider-catalog/history' },
    { title: 'Product Catalog', href: '/admin/packages' },
    { title: 'OPERATIONS', href: '#', sectionHeader: true },
    { title: 'Orders', href: '/admin/orders' },
    { title: 'eSIMs', href: '/admin/esims' },
    { title: 'Usage Analytics', href: '/admin/usage' },
    { title: 'Invoices', href: '/admin/invoices' },
    { title: 'Finance Dashboard', href: '/admin/finance' },
    { title: 'Credit Allocations', href: '/admin/wallet-topups' },
    { title: 'MONITORING', href: '#', sectionHeader: true },
    { title: 'Analytics', href: '/admin/analytics' },
    { title: 'API Analytics', href: '/admin/api-analytics' },
    { title: 'Alerts & Events', href: '/admin/alerts' },
    { title: 'System Monitoring', href: '/admin/monitoring' },
    { title: 'Performance', href: '/admin/performance' },
    { title: 'Provider Health', href: '/admin/provider-health' },
    { title: 'Support Queue', href: '/admin/support' },
    // Jobs — hidden for now
    { title: 'Audit Logs', href: '/admin/audit-logs' },
    { title: 'API Logs', href: '/admin/api-logs' },
    { title: 'Provider Webhooks', href: '/admin/provider-webhooks' },
    { title: 'Webhook Monitoring', href: '/admin/webhook-monitoring' },
    { title: 'Admin Users', href: '/admin/users' },
    { title: 'SYSTEM', href: '#', sectionHeader: true },
    { title: 'Settings', href: '/admin/settings' },
    { title: 'Account', href: '/admin/account' },
  ];

  return (
    <div className="flex h-screen">
      <Sidebar items={sidebarItems} portalName="ONESIM ADMIN" />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header title="OneSim Admin Portal" />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
