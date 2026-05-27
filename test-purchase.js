const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function simulatePurchaseRoute() {
  try {
    // Step 1: Find the package
    const pkg = await prisma.eSIMPackage.findUnique({
      where: { id: 'cmotoid5p0006pzn4mycjrim8', isActive: true }
    });
    if (!pkg) throw new Error('Package not found');
    console.log('Package found:', pkg.name);

    // Step 2: Find the business
    const business = await prisma.business.findUnique({
      where: { id: 'cmovg0cof0003o7pg7g7ydl9x' }
    });
    if (!business) throw new Error('Business not found');
    console.log('Business found:', business.name, 'Balance:', business.walletBalance.toString());

    // Step 3: Calculate price
    const totalPrice = parseFloat(pkg.priceUSD.toString()) * 1;
    console.log('Total price:', totalPrice);

    // Step 4: Check balance
    if (parseFloat(business.walletBalance.toString()) < totalPrice) {
      throw new Error('Insufficient balance');
    }
    console.log('Balance sufficient');

    // Step 5: Transaction
    const result = await prisma.$transaction(async (tx) => {
      console.log('Creating purchase...');
      const purchase = await tx.eSIMPurchase.create({
        data: {
          businessId: 'cmovg0cof0003o7pg7g7ydl9x',
          userId: 'cmovg0coi0004o7pgdp24kar0',
          packageId: 'cmotoid5p0006pzn4mycjrim8',
          quantity: 1,
          totalAmount: parseFloat(totalPrice.toString()),
          status: 'COMPLETED'
        }
      });
      console.log('Purchase created:', purchase.id);

      const esims = [];
      for (let i = 0; i < 1; i++) {
        const esim = await tx.eSIM.create({
          data: {
            purchaseId: purchase.id,
            iccid: `890123456789${Date.now()}${i}`,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000)
          }
        });
        esims.push(esim);
        console.log('ESIM created:', esim.id);
      }

      await tx.business.update({
        where: { id: 'cmovg0cof0003o7pg7g7ydl9x' },
        data: { walletBalance: { decrement: parseFloat(totalPrice.toString()) } }
      });
      console.log('Wallet decremented');

      await tx.walletTransaction.create({
        data: {
          businessId: 'cmovg0cof0003o7pg7g7ydl9x',
          amount: -totalPrice,
          type: 'PURCHASE',
          description: `Purchased 1x ${pkg.name}`
        }
      });
      console.log('Wallet transaction created');

      await tx.auditLog.create({
        data: {
          userId: 'cmovg0coi0004o7pgdp24kar0',
          action: 'PURCHASE_ESIM',
          entity: 'ESIMPurchase',
          entityId: purchase.id,
          details: `Purchased 1x ${pkg.name} for $${totalPrice}`
        }
      });
      console.log('Audit log created');

      return { purchase, esims };
    });

    console.log('All done! Purchase:', result.purchase.id);
  } catch (e) {
    console.error('Error:', e.message);
    console.error('Stack:', e.stack);
  } finally {
    await prisma.$disconnect();
  }
}

simulatePurchaseRoute();
