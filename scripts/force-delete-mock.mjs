import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

try {
  const providers = await prisma.provider.findMany({ where: { type: 'MOCK' } });
  if (providers.length === 0) { console.log('No MOCK providers found.'); process.exit(0); }

  for (const prov of providers) {
    console.log(`\nProcessing MOCK provider: ${prov.name} (${prov.id})`);

    const packages = await prisma.eSIMPackage.findMany({ where: { providerId: prov.id } });
    console.log(` Packages: ${packages.length}`);
    
    for (const pkg of packages) {
      const purchases = await prisma.eSIMPurchase.findMany({ where: { packageId: pkg.id }, select: { id: true } });
      console.log(`  Deleting package "${pkg.name}" (${pkg.id}) — ${purchases.length} purchase(s) will cascade`);
      
      await prisma.eSIMPackage.delete({ where: { id: pkg.id } });
      console.log(`  Deleted.`);
    }

    await prisma.provider.delete({ where: { id: prov.id } });
    console.log(` Deleted provider "${prov.name}".`);
  }

  console.log('\nAll MOCK data removed.');
} finally {
  await prisma.$disconnect();
}
