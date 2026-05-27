import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

try {
  // Find all packages with providerName containing 'mock' (case-insensitive) or linked to mock providers
  const mockPkgNames = ['MOCK', 'Mock', 'mock'];
  const packages = await prisma.eSIMPackage.findMany({
    where: { providerName: { in: mockPkgNames } },
    select: { id: true, name: true, providerName: true }
  });
  console.log('Packages with providerName=MOCK:', packages.length);
  for (const p of packages) console.log(' -', p.id, p.name, p.providerName);

  // Find all purchases for those packages
  const pkgIds = packages.map(p => p.id);
  if (pkgIds.length > 0) {
    const purchases = await prisma.eSIMPurchase.findMany({
      where: { packageId: { in: pkgIds } },
      select: { id: true, packageId: true }
    });
    console.log('\nPurchases from MOCK packages:', purchases.length);
    for (const p of purchases) console.log(' -', p.id, 'pkg:', p.packageId);

    const purchaseIds = purchases.map(p => p.id);
    if (purchaseIds.length > 0) {
      const esims = await prisma.eSIM.findMany({
        where: { purchaseId: { in: purchaseIds } },
        select: { id: true, iccid: true, status: true }
      });
      console.log('\neSIMs from MOCK purchases:', esims.length);
      for (const e of esims) console.log(' -', e.id, e.iccid, e.status);
    }
  }

  // Also check eSIMs directly linked to mock via other means
  const allEsims = await prisma.eSIM.findMany({ take: 5, select: { id: true, iccid: true, status: true, purchaseId: true } });
  console.log('\nAll eSIMs (first 5):', allEsims.length);
  for (const e of allEsims) console.log(' -', e.id, e.iccid, e.status, 'purchase:', e.purchaseId);

} finally {
  await prisma.$disconnect();
}
