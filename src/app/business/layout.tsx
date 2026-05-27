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
    { title: 'Dashboard', href: '/business/dashboard', icon: 'LayoutDashboard' as const },
    { title: 'Buy eSIM', href: '/business/buy-esim', icon: 'ShoppingCart' as const, readOnly: isMember },
    { title: 'Client eSIMs', href: '/business/esims', icon: 'SimCard' as const },
    { title: 'Customers', href: '/business/customers', icon: 'Users' as const, readOnly: isMember },
    { title: 'Orders', href: '/business/orders', icon: 'FileText' as const, readOnly: isMember },
    { title: 'Team Members', href: '/business/users', icon: 'Users' as const },
    { title: 'Wallet', href: '/business/wallet', icon: 'Wallet' as const, readOnly: isMember },
    { title: 'API Keys', href: '/business/api-keys', icon: 'Key' as const, readOnly: isMember },
    // Webhooks — hidden for now
    { title: 'Developers', href: '/business/developers', icon: 'FileCode' as const, readOnly: isMember },
    { title: 'API Usage', href: '/business/api-usage', icon: 'BarChart3' as const },
    { title: 'Usage', href: '/business/usage', icon: 'BarChart3' as const },
    { title: 'Account', href: '/business/account', icon: 'Settings' as const },
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
