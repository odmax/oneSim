import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { AdminDashboardView } from '@/components/dashboard/admin-dashboard-view';

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
      where: { status: { in: ['FULFILLED', 'ACTIVE', 'INSTALLED'] } },
    }),
  ]);

  const recentBusinesses = await prisma.business.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
  });

  const pendingCount = await prisma.business.count({
    where: { status: 'PENDING' }
  });

  return (
    <AdminDashboardView
      businessCount={businessCount}
      esimCount={esimCount}
      orderCount={orderCount}
      revenueFormatted={revenue._sum.totalAmount?.toFixed(2) || '0.00'}
      pendingCount={pendingCount}
      recentBusinesses={recentBusinesses.map((business) => ({
        id: business.id,
        name: business.name,
        country: business.country,
        status: business.status,
        createdAt: business.createdAt,
      }))}
      errorMessage={searchParams?.error ? decodeURIComponent(searchParams.error) : undefined}
      successMessage={searchParams?.success ? decodeURIComponent(searchParams.success) : undefined}
    />
  );
}
