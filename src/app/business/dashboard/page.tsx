import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  ShoppingCart,
  FileText,
  Users,
  Wallet,
  BarChart3,
  ArrowRight,
  Smartphone,
} from 'lucide-react';
import { orderStatusLabel } from '@/lib/status-labels';

function StatCard({ label, value, icon: Icon, color, gradient }: { label: string; value: string; icon: any; color: string; gradient: string }) {
  return (
    <div className={`rounded-xl border ${gradient} p-5 shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
          <p className={`mt-2 text-3xl font-bold ${color}`}>{value}</p>
        </div>
        <div className={`rounded-xl ${color.replace('text-', 'bg-').replace('600', '100')} p-3`}>
          <Icon className={`h-6 w-6 ${color}`} />
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cfg = orderStatusLabel(status)
  const dotColor = cfg.dot
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      {cfg.label}
    </span>
  )
}

export default async function BusinessDashboard() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login');
  }

  const isMember = session.user.businessRole === 'MEMBER';
  const businessId = session.user.businessId!;
  
  const [esimCount, orderCount, walletBalance, recentOrders] = await Promise.all([
    prisma.eSIM.count({
      where: { purchase: { businessId: businessId } }
    }),
    prisma.eSIMPurchase.count({
      where: { businessId }
    }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { walletBalance: true }
    }),
    prisma.eSIMPurchase.findMany({
      where: { businessId },
      include: { package: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  const quickActions = [
    { title: 'Buy eSIMs', description: 'Purchase new eSIM packages for your team', href: '/business/buy-esim', icon: ShoppingCart, restricted: isMember },
    { title: 'View eSIMs', description: 'Manage your active eSIMs and QR codes', href: '/business/esims', icon: Smartphone, restricted: false },
    { title: 'Orders & Invoices', description: 'Track your orders and download invoices', href: '/business/orders', icon: FileText, restricted: isMember },
    { title: 'Team Management', description: 'Invite and manage team members', href: '/business/users', icon: Users, restricted: isMember },
    { title: 'Top Up Wallet', description: 'Add funds to your wallet for quick purchases', href: '/business/wallet', icon: Wallet, restricted: isMember },
    { title: 'Usage Analytics', description: 'Monitor data usage across all eSIMs', href: '/business/usage', icon: BarChart3, restricted: false },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Welcome back, {session.user.name?.split(' ')[0]}!</h1>
        <p className="mt-1 text-sm text-gray-500">Manage your eSIMs, track usage, and top up your wallet.</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Wallet Balance" value={`$${walletBalance?.walletBalance.toFixed(2) || '0.00'}`} icon={Wallet} color="text-emerald-600" gradient="border-emerald-100 bg-gradient-to-br from-emerald-50 to-white" />
        <StatCard label="Active eSIMs" value={String(esimCount)} icon={Smartphone} color="text-blue-600" gradient="border-blue-100 bg-gradient-to-br from-blue-50 to-white" />
        <StatCard label="Total Orders" value={String(orderCount)} icon={FileText} color="text-purple-600" gradient="border-purple-100 bg-gradient-to-br from-purple-50 to-white" />
        <StatCard label="Data Used" value="—" icon={BarChart3} color="text-orange-600" gradient="border-orange-100 bg-gradient-to-br from-orange-50 to-white" />
      </div>

      {/* Quick Actions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Quick Actions</h2>
          {isMember && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
              Read-only access
            </span>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {quickActions.map((action) => (
            action.restricted ? (
              <div key={action.href} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm opacity-60 cursor-not-allowed select-none">
                <div className="flex items-start gap-4">
                  <div className="rounded-xl bg-gray-100 p-3">
                    <action.icon className="h-5 w-5 text-gray-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900">{action.title}</h3>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Read-only</span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">{action.description}</p>
                  </div>
                </div>
              </div>
            ) : (
              <Link key={action.href} href={action.href}>
                <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md hover:border-emerald-100 transition-all group">
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-emerald-50 p-3 group-hover:bg-emerald-100 transition-colors">
                      <action.icon className="h-5 w-5 text-emerald-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900">{action.title}</h3>
                      <p className="mt-0.5 text-xs text-gray-400">{action.description}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-gray-300 mt-1 group-hover:text-emerald-500 group-hover:translate-x-0.5 transition-all" />
                  </div>
                </div>
              </Link>
            )
          ))}
        </div>
        {isMember && (
          <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-700">
              <span className="font-medium">Note:</span> Business Members have read-only access. Contact your Business Admin for full access.
            </p>
          </div>
        )}
      </div>

      {/* Recent Orders */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent Orders</h2>
          <Link href="/business/orders" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">
            View All <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
          </Link>
        </div>
        {recentOrders.length > 0 ? (
          <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Total</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recentOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-gray-900">{order.package.displayName || order.package.name}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">{order.quantity}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-semibold text-gray-900">${order.totalAmount.toFixed(2)}</td>
                    <td className="whitespace-nowrap px-5 py-4"><StatusBadge status={order.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-10 text-center">
            <p className="text-sm text-gray-500">No orders yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
