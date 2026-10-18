import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { sanitizePublicText } from '@/lib/catalog/public-package-presentation';
import { BusinessDashboardView } from '@/components/dashboard/business-dashboard-view';

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

  return (
    <BusinessDashboardView
      firstName={session.user.name?.split(' ')[0]}
      businessName={session.user.businessName}
      isMember={isMember}
      walletFormatted={walletBalance?.walletBalance.toFixed(2) || '0.00'}
      esimCount={esimCount}
      orderCount={orderCount}
      recentOrders={recentOrders.map((order) => ({
        id: order.id,
        packageName: sanitizePublicText(order.package.displayName || order.package.name, null, order.package.providerName) || order.package.displayName || order.package.name,
        dataGB: order.packageDataGB ?? order.package.dataGB,
        validityDays: order.packageValidityDays ?? order.package.validityDays,
        quantity: order.quantity,
        amountFormatted: order.totalAmount.toFixed(2),
        status: order.status,
        createdAt: order.createdAt,
      }))}
    />
  );
}
