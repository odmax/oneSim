import { PrismaClient, UserRole, BusinessStatus, BusinessUserRole, InternalAdminRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

// ── Provider Framework V2: Operation & Feature Pack definitions ──────────

const PV2_OPERATIONS: Array<{ code: string; name: string; description: string; category: string }> = [
  { code: 'AUTHENTICATE', name: 'Authenticate', description: 'Obtain or refresh authentication credentials', category: 'AUTH' },
  { code: 'TEST_CONNECTION', name: 'Test Connection', description: 'Test connectivity to provider', category: 'AUTH' },
  { code: 'HEALTH_CHECK', name: 'Health Check', description: 'Provider health check', category: 'AUTH' },

  { code: 'SYNC_CATALOG', name: 'Sync Catalog', description: 'Synchronize product catalog', category: 'SYNC' },
  { code: 'SYNC_PRICING', name: 'Sync Pricing', description: 'Synchronize pricing data', category: 'SYNC' },
  { code: 'SYNC_INVENTORY', name: 'Sync Inventory', description: 'Synchronize inventory levels', category: 'SYNC' },
  { code: 'SYNC_STATUS', name: 'Sync Status', description: 'Synchronize status data', category: 'SYNC' },

  { code: 'GET_PRODUCTS', name: 'Get Products', description: 'List available products/plans', category: 'CATALOG' },
  { code: 'GET_PRODUCT', name: 'Get Product', description: 'Get a specific product/plan', category: 'CATALOG' },
  { code: 'GET_BALANCE', name: 'Get Balance', description: 'Query account balance', category: 'ACCOUNT' },
  { code: 'GET_USAGE', name: 'Get Usage', description: 'Query usage data', category: 'ACCOUNT' },

  { code: 'CREATE_CUSTOMER', name: 'Create Customer', description: 'Create a new customer', category: 'CUSTOMER' },
  { code: 'GET_CUSTOMER', name: 'Get Customer', description: 'Get customer details', category: 'CUSTOMER' },
  { code: 'UPDATE_CUSTOMER', name: 'Update Customer', description: 'Update customer details', category: 'CUSTOMER' },

  { code: 'CREATE_ORDER', name: 'Create Order', description: 'Place a new order', category: 'ORDER' },
  { code: 'GET_ORDER', name: 'Get Order', description: 'Get order details', category: 'ORDER' },
  { code: 'CANCEL_ORDER', name: 'Cancel Order', description: 'Cancel an existing order', category: 'ORDER' },

  { code: 'ALLOCATE_ESIM', name: 'Allocate eSIM', description: 'Allocate an eSIM profile', category: 'ESIM' },
  { code: 'GET_ESIM', name: 'Get eSIM', description: 'Get eSIM details', category: 'ESIM' },
  { code: 'ACTIVATE_ESIM', name: 'Activate eSIM', description: 'Activate an eSIM profile', category: 'ESIM' },

  { code: 'CREATE_SUBSCRIPTION', name: 'Create Subscription', description: 'Create a new subscription', category: 'SUBSCRIPTION' },
  { code: 'GET_SUBSCRIPTION', name: 'Get Subscription', description: 'Get subscription details', category: 'SUBSCRIPTION' },
  { code: 'UPDATE_SUBSCRIPTION', name: 'Update Subscription', description: 'Update subscription', category: 'SUBSCRIPTION' },
  { code: 'SUSPEND_SUBSCRIPTION', name: 'Suspend Subscription', description: 'Suspend a subscription', category: 'SUBSCRIPTION' },
  { code: 'RESTORE_SUBSCRIPTION', name: 'Restore Subscription', description: 'Restore a suspended subscription', category: 'SUBSCRIPTION' },
  { code: 'CANCEL_SUBSCRIPTION', name: 'Cancel Subscription', description: 'Cancel a subscription', category: 'SUBSCRIPTION' },

  { code: 'ADD_PLAN', name: 'Add Plan', description: 'Add a plan to an eSIM', category: 'PLAN' },
  { code: 'REMOVE_PLAN', name: 'Remove Plan', description: 'Remove a plan from an eSIM', category: 'PLAN' },
  { code: 'EXPIRE_PLAN', name: 'Expire Plan', description: 'Expire a plan', category: 'PLAN' },
  { code: 'REPROVISION_PLAN', name: 'Reprovision Plan', description: 'Reprovision a plan', category: 'PLAN' },

  { code: 'REGISTER_WEBHOOK', name: 'Register Webhook', description: 'Register a webhook endpoint', category: 'WEBHOOK' },
  { code: 'PROCESS_WEBHOOK', name: 'Process Webhook', description: 'Process an incoming webhook', category: 'WEBHOOK' },
]

const PV2_FEATURE_PACKS: Array<{
  code: string
  name: string
  description: string
  operations: string[]
}> = [
  { code: 'AUTHENTICATION', name: 'Authentication', description: 'Provider authentication and connection management', operations: ['AUTHENTICATE', 'TEST_CONNECTION', 'HEALTH_CHECK'] },
  { code: 'CATALOG', name: 'Catalog', description: 'Product catalog management', operations: ['GET_PRODUCTS', 'GET_PRODUCT', 'SYNC_CATALOG'] },
  { code: 'PRICING', name: 'Pricing', description: 'Pricing data management', operations: ['SYNC_PRICING'] },
  { code: 'INVENTORY', name: 'Inventory', description: 'Inventory management', operations: ['SYNC_INVENTORY'] },
  { code: 'CUSTOMERS', name: 'Customers', description: 'Customer management', operations: ['CREATE_CUSTOMER', 'GET_CUSTOMER', 'UPDATE_CUSTOMER'] },
  { code: 'ORDERS', name: 'Orders', description: 'Order management', operations: ['CREATE_ORDER', 'GET_ORDER', 'CANCEL_ORDER'] },
  { code: 'ESIMS', name: 'eSIMs', description: 'eSIM lifecycle management', operations: ['ALLOCATE_ESIM', 'GET_ESIM', 'ACTIVATE_ESIM'] },
  { code: 'SUBSCRIPTIONS', name: 'Subscriptions', description: 'Subscription lifecycle management', operations: ['CREATE_SUBSCRIPTION', 'GET_SUBSCRIPTION', 'UPDATE_SUBSCRIPTION', 'SUSPEND_SUBSCRIPTION', 'RESTORE_SUBSCRIPTION', 'CANCEL_SUBSCRIPTION'] },
  { code: 'USAGE', name: 'Usage', description: 'Usage data tracking', operations: ['GET_USAGE', 'SYNC_STATUS'] },
  { code: 'BALANCE', name: 'Balance', description: 'Balance management', operations: ['GET_BALANCE'] },
  { code: 'NOTIFICATIONS', name: 'Notifications', description: 'Notification handling', operations: [] },
  { code: 'WEBHOOKS', name: 'Webhooks', description: 'Webhook management', operations: ['REGISTER_WEBHOOK', 'PROCESS_WEBHOOK'] },
  { code: 'DEVICE_VALIDATION', name: 'Device Validation', description: 'Device validation and compatibility', operations: [] },
  { code: 'ADDRESS_VALIDATION', name: 'Address Validation', description: 'Address validation', operations: [] },
  { code: 'PORTABILITY', name: 'Portability', description: 'Number portability', operations: [] },
  { code: 'BILLING', name: 'Billing', description: 'Billing and invoicing', operations: [] },
  { code: 'HEALTH', name: 'Health', description: 'Health monitoring and alerting', operations: ['HEALTH_CHECK'] },
]

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

  // ── Provider Framework V2: Seed operations registry (idempotent) ──────
  const operationMap = new Map<string, string>() // code → id
  for (const op of PV2_OPERATIONS) {
    const existing = await prisma.pV2Operation.findUnique({ where: { code: op.code } })
    if (existing) {
      operationMap.set(op.code, existing.id)
    } else {
      const created = await prisma.pV2Operation.create({
        data: { ...op, isSystem: true, isActive: true },
      })
      operationMap.set(op.code, created.id)
    }
  }

  // ── Provider Framework V2: Seed feature packs (idempotent) ───────────
  for (const fp of PV2_FEATURE_PACKS) {
    const existing = await prisma.pV2FeaturePack.findUnique({ where: { code: fp.code } })
    const featurePackId = existing?.id ?? (
      await prisma.pV2FeaturePack.create({
        data: { code: fp.code, name: fp.name, description: fp.description, version: 1, isActive: true },
      })
    ).id

    for (const opCode of fp.operations) {
      const operationId = operationMap.get(opCode)
      if (!operationId) continue
      await prisma.pV2FeaturePackOperation.upsert({
        where: { featurePackId_operationId: { featurePackId, operationId } },
        update: {},
        create: { featurePackId, operationId, isRequired: true },
      })
    }
  }

  console.log(`[PV2 Seed] Seeded ${operationMap.size} operations and ${PV2_FEATURE_PACKS.length} feature packs.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
