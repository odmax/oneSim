import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const airhubEndpoints = {
  AUTH_LOGIN: 'POST /api/Authentication/UserLogin',
  GET_PLANS: 'POST /api/ESIM/GetPlanInformation',
  PURCHASE_ESIM: 'POST /api/ESIM/PurchaseEsim',
  WALLET_BALANCE: 'POST /api/ESIM/GetWallet',
  ORDER_DETAILS: 'POST /api/ESIM/OrderDetails',
  GET_ACTIVATION_CODE: 'POST /api/ESIM/GetActivationCode',
  COUNTRY_REGION_DETAILS: 'GET /api/ESIM/Getcountry_regiondetail?flag=2',
  TOP_UP: 'POST /api/ESIM/InsertRenew',
  RENEW_ESIM: 'POST /api/ESIM/InsertRenew',
}

try {
console.log('Seeding Airhub Outreach system template...')

  const existing = await prisma.providerTemplate.findFirst({ where: { name: 'Airhub Outreach' } })
  if (existing) {
    console.log('Airhub Outreach template already exists. Updating...')
    await prisma.providerTemplate.update({
      where: { id: existing.id },
      data: {
        description: 'Airhub eSIM provider template. Supports eSIM purchase, plan sync, wallet balance, activation code retrieval, and top-up/renewal.',
        connectorType: 'STANDARD',
        authType: 'credentials',
        tokenPlacement: 'BEARER_HEADER',
        defaultAuthUrl: '/api/Authentication/UserLogin',
        defaultPlanListPath: '/api/ESIM/GetPlanInformation',
        defaultActivationPath: '/api/ESIM/PurchaseEsim',
        defaultResponseListKey: 'getInformation',
        defaultFieldMappings: {
          sku: 'planCode',
          name: 'planName',
          price_usd: 'price',
          currency: 'currency',
          validity_days: 'vaildity',
          data_amount: 'capacity',
          data_unit: 'capacityUnit',
          country: 'countryName',
          network: 'network_operator',
          type: 'connectivity',
          description: 'additionalInfo',
        },
        defaultCapabilities: {
          supportsESIM: true,
          supportsTopUp: true,
          supportsQRCode: true,
          supportsRenewals: true,
        },
        endpointMappings: airhubEndpoints,
        requestMappings: {
          AUTH_LOGIN: { userName: '{{username}}', password: '{{password}}' },
          GET_PLANS: { partnerCode: '{{auth.partnerCode}}', flag: '{{config.flag|5}}', countryCode: '{{config.countryCode|US}}', multiplecountrycode: '{{config.multiplecountrycode}}' },

          PURCHASE_ESIM: { partnerCode: '{{auth.partnerCode}}', planCode: '{{planCode}}', quantity: '1', email: '{{email}}' },
        },
        requiredConfigFields: [
          { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Airhub API username' },
          { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Airhub API password' },
        ],
        optionalConfigFields: [
          { name: 'countryCode', label: 'Country Code', type: 'text', required: false, placeholder: 'US' },
          { name: 'multiplecountrycode', label: 'Countries (comma separated)', type: 'text', required: false, placeholder: 'US,GB,ZA' },
          { name: 'flag', label: 'Flag', type: 'number', required: false, placeholder: '5' },
          { name: 'partnerCodeOverride', label: 'Partner Code Override', type: 'number', required: false, placeholder: 'Only set if auth-derived code differs' },
        ],
        isSystemTemplate: true,
      },
    })
  } else {
    await prisma.providerTemplate.create({
      data: {
        name: 'Airhub Outreach',
        description: 'Airhub eSIM provider template. Supports eSIM purchase, plan sync, wallet balance, activation code retrieval, and top-up/renewal.',
        connectorType: 'STANDARD',
        authType: 'credentials',
        tokenPlacement: 'BEARER_HEADER',
        defaultAuthUrl: '/api/Authentication/UserLogin',
        defaultPlanListPath: '/api/ESIM/GetPlanInformation',
        defaultActivationPath: '/api/ESIM/PurchaseEsim',
        defaultResponseListKey: 'getInformation',
        defaultFieldMappings: {
          sku: 'planCode',
          name: 'planName',
          price_usd: 'price',
          currency: 'currency',
          validity_days: 'vaildity',
          data_amount: 'capacity',
          data_unit: 'capacityUnit',
          country: 'countryName',
          network: 'network_operator',
          type: 'connectivity',
          description: 'additionalInfo',
        },
        defaultCapabilities: {
          supportsESIM: true,
          supportsTopUp: true,
          supportsQRCode: true,
          supportsRenewals: true,
        },
        endpointMappings: airhubEndpoints,
        requestMappings: {
          AUTH_LOGIN: { userName: '{{username}}', password: '{{password}}' },
          GET_PLANS: { partnerCode: '{{auth.partnerCode}}', flag: '{{config.flag|5}}', countryCode: '{{config.countryCode|US}}', multiplecountrycode: '{{config.multiplecountrycode}}' },
          PURCHASE_ESIM: { partnerCode: '{{auth.partnerCode}}', planCode: '{{planCode}}', quantity: '1', email: '{{email}}' },
        },
        requiredConfigFields: [
          { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Airhub API username' },
          { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Airhub API password' },
        ],
        optionalConfigFields: [
          { name: 'countryCode', label: 'Country Code', type: 'text', required: false, placeholder: 'US' },
          { name: 'multiplecountrycode', label: 'Countries (comma separated)', type: 'text', required: false, placeholder: 'US,GB,ZA' },
          { name: 'flag', label: 'Flag', type: 'number', required: false, placeholder: '5' },
          { name: 'partnerCodeOverride', label: 'Partner Code Override', type: 'number', required: false, placeholder: 'Only set if auth-derived code differs' },
        ],
        isSystemTemplate: true,
      },
    })
  }
  console.log('Airhub Outreach template ready.')
  console.log('')
  console.log('To connect Airhub as a provider:')
  console.log('  1. Admin → Providers → Add Provider')
  console.log('  2. Select template: Airhub Outreach')
  console.log('  3. Enter your Airhub base URL, username, password, partnerCode')
  console.log('  4. Save → Test Connection → Sync Plans')
  console.log('')

  await prisma.$disconnect()
} catch (e) { console.error(e); process.exit(1) }
