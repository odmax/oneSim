import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { 
  Building2, 
  ShoppingCart, 
  BarChart3,
  ArrowRight,
  FileText,
} from 'lucide-react';

export default async function AdminDashboard({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login');
  }

  const [businessCount, esimCount, orderCount, revenue] = await Promise.all([
    prisma.business.count({ where: { status: 'APPROVED' } }),
    prisma.eSIM.count(),
    prisma.eSIMPurchase.count(),
    prisma.eSIMPurchase.aggregate({
      _sum: { totalAmount: true },
      where: { status: 'COMPLETED' },
    }),
  ]);

  const recentBusinesses = await prisma.business.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
  });

  const pendingCount = await prisma.business.count({
    where: { status: 'PENDING' }
  });

  // Annual markup — deprecated

  const quickActions = [
    {
      title: 'Manage Businesses',
      description: 'Approve, suspend, and manage business accounts',
      href: '/admin/businesses',
      icon: Building2,
      color: 'bg-cyan-600',
    },
    {
      title: 'eSIM Packages',
      description: 'Create and manage eSIM packages',
      href: '/admin/packages',
      icon: ShoppingCart,
      color: 'bg-green-600',
    },
    {
      title: 'View All Orders',
      description: 'Monitor all eSIM purchases across businesses',
      href: '/admin/orders',
      icon: FileText,
      color: 'bg-purple-600',
    },
    {
      title: 'Monitor eSIMs',
      description: 'Track all provisioned eSIMs and their status',
      href: '/admin/esims',
      icon: BarChart3,
      color: 'bg-orange-600',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="mt-2 text-gray-600">
          Oversee all businesses, monitor eSIM usage, and manage platform settings.
        </p>
      </div>

      {searchParams?.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}

      {searchParams?.success && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {decodeURIComponent(searchParams.success)}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <div className="stat-card hover:border-cyan-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">Total Businesses</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{businessCount}</p>
            </div>
            <div className="rounded-full bg-cyan-100 p-3">
              <Building2 className="h-6 w-6 text-cyan-600" />
            </div>
          </div>
        </div>

        <div className="stat-card hover:border-yellow-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">Pending Approvals</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{pendingCount}</p>
            </div>
            <div className="rounded-full bg-yellow-100 p-3">
              <Building2 className="h-6 w-6 text-yellow-600" />
            </div>
          </div>
        </div>

        <div className="stat-card hover:border-purple-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">Total Orders</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{orderCount}</p>
            </div>
            <div className="rounded-full bg-purple-100 p-3">
              <FileText className="h-6 w-6 text-purple-600" />
            </div>
          </div>
        </div>

        <div className="stat-card hover:border-orange-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">Revenue</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">
                ${revenue._sum.totalAmount?.toFixed(2) || '0.00'}
              </p>
            </div>
            <div className="rounded-full bg-orange-100 p-3">
              <BarChart3 className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="mb-4 text-xl font-semibold text-gray-900">Quick Actions</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {quickActions.map((action) => (
            <Link key={action.href} href={action.href}>
              <div className="dashboard-card border-gray-100">
                <div className="flex items-start gap-4">
                  <div className={`rounded-xl ${action.color} p-3 shadow-sm`}>
                    <action.icon className="h-6 w-6 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900">{action.title}</h3>
                    <p className="mt-1 text-sm text-gray-500">{action.description}</p>
                  </div>
                  <ArrowRight className="h-5 w-5 text-gray-400 group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Annual markup — removed; pricing is manual per product */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Recent Businesses</h2>
          <Link href="/admin/businesses">
            <Button variant="ghost" size="sm" className="text-cyan-600 hover:text-cyan-700">
              View All <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
        <div className="space-y-4">
          {recentBusinesses.map((business) => (
            <div key={business.id} className="rounded-xl border-0 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{business.name}</p>
                  <p className="text-sm text-gray-500">{business.country}</p>
                </div>
                <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                  business.status === 'APPROVED' 
                    ? 'bg-green-100 text-green-800' 
                    : business.status === 'SUSPENDED'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-yellow-100 text-yellow-800'
                }`}>
                  {business.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
