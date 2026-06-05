import Sidebar from '@/components/layout/sidebar'
import Header from '@/components/layout/header';
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

export default async function BusinessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions)
  
  if (session?.user?.role === 'BUSINESS_USER' && session.user.businessId) {
    const business = await prisma.business.findUnique({
      where: { id: session.user.businessId },
      select: { status: true }
    })
    
    if (business) {
      if (business.status === 'SUSPENDED') {
        redirect('/business/suspended')
      } else if (business.status !== 'APPROVED') {
        redirect('/business/pending')
      }
    }
  }

  const isMember = session?.user?.businessRole === 'MEMBER'

  const sidebarItems = [
    { title: 'Overview', href: '#', sectionHeader: true },
    { title: 'Dashboard', href: '/business/dashboard', icon: 'LayoutDashboard' as const },

    { title: 'Sales & eSIMs', href: '#', sectionHeader: true },
    { title: 'Buy eSIMs', href: '/business/buy-esim', icon: 'ShoppingCart' as const, readOnly: isMember },
    { title: 'eSIM Inventory', href: '/business/esims', icon: 'SimCard' as const },
    { title: 'eSIM Usage', href: '/business/esim-usage', icon: 'BarChart3' as const },
    { title: 'Customers', href: '/business/customers', icon: 'Users' as const, readOnly: isMember },
    { title: 'Orders', href: '/business/orders', icon: 'FileText' as const, readOnly: isMember },

    { title: 'Finance', href: '#', sectionHeader: true },
    { title: 'Wallet Credit', href: '/business/wallet', icon: 'Wallet' as const, readOnly: isMember },

    { title: 'Developer Tools', href: '#', sectionHeader: true },
    { title: 'API Keys', href: '/business/api-keys', icon: 'Key' as const, readOnly: isMember },
    { title: 'API Documentation', href: '/business/developers', icon: 'FileCode' as const, readOnly: isMember },
    { title: 'API Analytics', href: '/business/api-analytics', icon: 'BarChart3' as const },
    { title: 'API Logs', href: '/business/api-usage', icon: 'List' as const },
    { title: 'Webhooks', href: '/business/webhooks', icon: 'Webhook' as const, readOnly: isMember },

    { title: 'Account', href: '#', sectionHeader: true },
    { title: 'Team Members', href: '/business/users', icon: 'Users' as const },
    { title: 'Account Settings', href: '/business/account', icon: 'Settings' as const },
  ];

  return (
    <div className="flex h-screen">
      <Sidebar items={sidebarItems} portalName={session?.user?.businessName || "Business Client"} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header title="Business Client Portal" />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
