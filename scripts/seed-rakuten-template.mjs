import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const rakutenEndpoints = {
  AUTH_LOGIN: 'POST /client/auth/token',
  GET_PLANS: 'GET /client/package-templates/all?page=1&pageSize=50&inventoryId=4ca24027-e2fc-4abc-9c06-7cee7a56cc61&coverageType=&coverageRegion=&includeCountries=true',
  PURCHASE_INITIATE: 'POST /purchase/initiate-purchase',
  PURCHASE_FULFILL: 'POST /purchase/fulfill-purchase?reservationId={{reservationId}}',
  GET_PACKAGES: 'GET /client/packages',
  GET_USAGE: 'GET /client/packages/usage?iccid={{iccid}}',
  GET_READY_SIMS: 'GET /client/sim-registries/ready?inventoryId={{inventoryId}}',
  GET_INVENTORIES: 'GET /client/inventory/all?page=0&pageSize=100',
  GET_CDRS: 'GET /network-access/cdrs?iccid={{iccid}}',
}

try {
  console.log('Seeding Rakuten Mobile template...')

  const existing = await prisma.providerTemplate.findFirst({ where: { name: 'Rakuten Mobile' } })
  const data = {
    name: 'Rakuten Mobile',
    description: 'Rakuten Mobile eSIM provider. Staging: https://stg-api-b2b-prepaid-sim.rmb-lab.jp/v1/esim | Production: https://api-partner-prepaid-sim.mobile.rakuten.com/v1/esim. Supports eSIM purchase, plan sync, usage, and inventory.',
    connectorType: 'STANDARD',
    authType: 'credentials',
    tokenPlacement: 'BEARER_HEADER',
    defaultBaseUrl: 'https://stg-api-b2b-prepaid-sim.rmb-lab.jp/v1/esim',
    defaultAuthUrl: '/client/auth/token',
    defaultPlanListPath: '/client/package-templates/all?page=1&pageSize=50&inventoryId=4ca24027-e2fc-4abc-9c06-7cee7a56cc61&coverageType=&coverageRegion=&includeCountries=true',
    defaultActivationPath: '/purchase/initiate-purchase',
    defaultResponseListKey: 'result.package_templates',
    defaultFieldMappings: {
      sku: 'id',
      name: 'name',
      price_usd: 'price.value',
      currency: 'price.currency',
      validity_days: 'validity_days',
      data_gb: 'data_usage_allowance_gb',
      country: 'coverage_region',
      type: 'coverage_type',
      supported_countries: 'supported_countries',
    },
    defaultCapabilities: {
      supportsESIM: true,
      supportsQRCode: true,
      supportsUsage: true,
    },
    responseMappings: {
      tokenPath: 'result.access_token',
    },
    endpointMappings: rakutenEndpoints,
    requestMappings: {
      AUTH_LOGIN: { username: '{{username}}', password: '{{password}}' },
      PURCHASE_INITIATE: { packageTemplateId: '{{planCode}}' },
    },
    requiredConfigFields: [
      { name: 'username', label: 'API Username', type: 'text', required: true, placeholder: 'Rakuten API username' },
      { name: 'password', label: 'API Password', type: 'password', required: true, placeholder: 'Rakuten API password' },
    ],
    isSystemTemplate: true,
  }

  if (existing) {
    await prisma.providerTemplate.update({ where: { id: existing.id }, data })
    console.log('Rakuten Mobile template updated.')
  } else {
    await prisma.providerTemplate.create({ data })
    console.log('Rakuten Mobile template created.')
  }

  console.log('')
  console.log('To connect Rakuten as a provider:')
  console.log('  1. Admin → Providers → Add Provider')
  console.log('  2. Select template: Rakuten Mobile')
  console.log('  3. Enter base URL, username, password')
  console.log('  4. Save → Authenticate → Sync Plans')
  console.log('')

  await prisma.$disconnect()
} catch (e) { console.error(e); process.exit(1) }
