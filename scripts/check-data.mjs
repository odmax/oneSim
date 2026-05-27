import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

try {
  const purchaseId = 'cmov2ly7i000f137gfx6uqahp';
  const purchase = await prisma.eSIMPurchase.findUnique({
    where: { id: purchaseId },
    include: { package: true }
  });
  if (purchase) {
    console.log('Purchase:', purchase.id, '| businessId:', purchase.businessId, '| userId:', purchase.userId);
    console.log('Package:', purchase.package?.id, purchase.package?.name, '| providerName:', purchase.package?.providerName, '| providerId:', purchase.package?.providerId);
  } else {
    console.log('Purchase not found - already deleted');
  }

  // Check all purchases in the system
  const allPurchases = await prisma.eSIMPurchase.findMany({ take: 10, include: { package: { select: { name: true, providerName: true } } } });
  console.log('\nAll purchases:');
  for (const p of allPurchases) {
    console.log(' -', p.id, '| business:', p.businessId, '| pkg:', p.package?.name, '| prov:', p.package?.providerName);
  }

  // Check all providers
  const allProviders = await prisma.provider.findMany({ select: { id: true, name: true, type: true } });
  console.log('\nAll providers:');
  for (const p of allProviders) console.log(' -', p.id, p.name, p.type);

} finally {
  await prisma.$disconnect();
}
