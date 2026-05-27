import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const providers = await prisma.provider.findMany({ where: { type: 'MOCK' } });
  console.log('MOCK providers:', providers.length);
  for (const p of providers) {
    console.log(' -', p.id, p.name, p.code);
  }

  const mockPkgs = providers.length > 0
    ? await prisma.eSIMPackage.findMany({ 
        where: { providerId: { in: providers.map(p => p.id) } },
        include: { _count: { select: { purchases: true } } }
      })
    : [];
  console.log('\nPackages linked to MOCK providers:', mockPkgs.length);
  for (const p of mockPkgs) {
    console.log(' -', p.id, p.name, 'purchases:', p._count.purchases);
  }
} finally {
  await prisma.$disconnect();
}
