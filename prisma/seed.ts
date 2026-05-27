import { PrismaClient, UserRole, BusinessStatus, BusinessUserRole, InternalAdminRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const saltRounds = parseInt(process.env.SEED_SALT_ROUNDS || '10', 10)
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@onesim.africa'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin123'
  const businessEmail = process.env.SEED_BUSINESS_EMAIL || 'business@demo.com'
  const businessPassword = process.env.SEED_BUSINESS_PASSWORD || 'business123'

  // Upsert admin user (idempotent)
  const adminPasswordHash = await bcrypt.hash(adminPassword, saltRounds)
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      passwordHash: adminPasswordHash,
      name: 'Super Admin',
      role: UserRole.INTERNAL_ADMIN,
      isActive: true,
    },
    create: {
      email: adminEmail,
      passwordHash: adminPasswordHash,
      name: 'Super Admin',
      role: UserRole.INTERNAL_ADMIN,
      isActive: true,
      internalAdmin: {
        create: {
          role: InternalAdminRole.SUPER_ADMIN,
        },
      },
    },
  })

  // Upsert demo business (idempotent)
  const businessName = process.env.SEED_BUSINESS_NAME || 'Demo Company'
  const businessReg = process.env.SEED_BUSINESS_REG || 'SEED-DEMO-001'
  let business = await prisma.business.findFirst({ where: { regNumber: businessReg } })
  if (business) {
    business = await prisma.business.update({
      where: { id: business.id },
      data: {
        name: businessName,
        contactEmail: businessEmail,
        status: BusinessStatus.APPROVED,
        walletBalance: parseFloat(process.env.SEED_BUSINESS_WALLET || '1000'),
      },
    })
  } else {
    business = await prisma.business.create({
      data: {
        name: businessName,
        regNumber: businessReg,
        taxId: process.env.SEED_BUSINESS_TAX || 'TAX-DEMO-001',
        contactEmail: businessEmail,
        contactPhone: process.env.SEED_BUSINESS_PHONE || '',
        address: process.env.SEED_BUSINESS_ADDRESS || '',
        country: process.env.SEED_BUSINESS_COUNTRY || 'ZA',
        status: BusinessStatus.APPROVED,
        walletBalance: parseFloat(process.env.SEED_BUSINESS_WALLET || '1000'),
      },
    })
  }

  // Upsert business admin user (idempotent)
  const businessPasswordHash = await bcrypt.hash(businessPassword, saltRounds)
  const existingBusinessUser = await prisma.user.findUnique({ where: { email: businessEmail } })
  if (existingBusinessUser) {
    await prisma.user.update({
      where: { email: businessEmail },
      data: { passwordHash: businessPasswordHash, name: 'Business Admin', role: UserRole.BUSINESS_USER, isActive: true },
    })
  } else {
    await prisma.user.create({
      data: {
        email: businessEmail,
        passwordHash: businessPasswordHash,
        name: 'Business Admin',
        role: UserRole.BUSINESS_USER,
        isActive: true,
        businessUsers: {
          create: {
            businessId: business.id,
            role: BusinessUserRole.ADMIN,
          },
        },
      },
    })
  }

  // Idempotent eSIM package creation
  const defaultPackages = [
    { name: 'Travel Basic', dataGB: 5, validityDays: 7, priceUSD: 10 },
    { name: 'Travel Plus', dataGB: 10, validityDays: 30, priceUSD: 25 },
    { name: 'Business Pro', dataGB: 50, validityDays: 90, priceUSD: 80 },
  ]
  for (const pkg of defaultPackages) {
    const existing = await prisma.eSIMPackage.findFirst({ where: { name: pkg.name } })
    if (!existing) {
      await prisma.eSIMPackage.create({
        data: {
          ...pkg,
          description: `Seed package: ${pkg.name}`,
          localPrice: pkg.priceUSD * 100,
          currency: 'USD',
          isActive: true,
        },
      })
    }
  }

  // Create default annual markup for current year (idempotent)
  const currentYear = new Date().getFullYear()
  const existingMarkup = await prisma.annualMarkupSetting.findUnique({
    where: { year: currentYear },
  })
  if (!existingMarkup) {
    await prisma.annualMarkupSetting.create({
      data: {
        year: currentYear,
        markupPercent: 20,
        isActive: true,
        createdBy: admin.id,
      },
    })
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
