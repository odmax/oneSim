/**
 * OneSim Africa — Staging Provider Setup
 *
 * Creates/updates provider templates and provider records for:
 *   - Airhub Outreach (template-based)
 *   - Rakuten Mobile (template-based)
 *   - Choice Wireless (legacy connector-based)
 *
 * All records are set to environment=STAGING, status=TESTING.
 * Production URLs are noted as pending in provider config.
 *
 * Idempotent: safe to run multiple times. Uses upsert by code/template name.
 *
 * Usage:
 *   node scripts/seed-staging-providers.mjs
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const STAGING_NOTE = {
  _productionUrlPending: true,
  _note: 'Production URL not configured. Set apiBaseUrl to production endpoint before going live.',
  _setupVia: 'seed-staging-providers.mjs',
}

// ─── Template & Provider definitions ──────────────────────────────────────────

const templates = [
  // ── Airhub Outreach ─────────────────────────────────────────────────────────
  {
    name: 'Airhub Outreach',
    match: { name: 'Airhub Outreach' },
    data: {
      description: 'Airhub eSIM provider template. Supports eSIM purchase, plan sync, wallet balance, activation code retrieval, and top-up/renewal.',
      connectorType: 'STANDARD',
      authType: 'credentials',
      tokenPlacement: 'BEARER_HEADER',
      defaultBaseUrl: 'https://staging-api.airhub.com/v1',   // example — confirm with provider
      defaultAuthUrl: '/api/Authentication/UserLogin',
      defaultPlanListPath: '/api/ESIM/GetPlanInformation',
      defaultActivationPath: '/api/ESIM/PurchaseEsim',
      defaultResponseListKey: 'data',
      defaultFieldMappings: {
        sku: 'planCode', name: 'planName', price_usd: 'price', currency: 'currency',
        validity_days: 'vaildity', data_amount: 'capacity', data_unit: 'capacityUnit',
        country: 'countryName', network: 'network_operator', type: 'connectivity',
        description: 'additionalInfo',
      },
      defaultCapabilities: { supportsESIM: true, supportsTopUp: true, supportsQRCode: true },
      endpointMappings: {
        AUTH_LOGIN: 'POST /api/Authentication/UserLogin',
        GET_PLANS: 'POST /api/ESIM/GetPlanInformation',
        PURCHASE_ESIM: 'POST /api/ESIM/PurchaseEsim',
        WALLET_BALANCE: 'POST /api/ESIM/GetWallet',
        ORDER_DETAILS: 'POST /api/ESIM/OrderDetails',
        GET_ACTIVATION_CODE: 'POST /api/ESIM/GetActivationCode',
        COUNTRY_REGION_DETAILS: 'GET /api/ESIM/Getcountry_regiondetail?flag=2',
        TOP_UP: 'POST /api/ESIM/InsertRenew',
        RENEW_ESIM: 'POST /api/ESIM/InsertRenew',
      },
      requestMappings: {
        AUTH_LOGIN: { userName: '{{username}}', password: '{{password}}' },
        GET_PLANS: { partnerCode: '{{partnerCode}}', flag: 0, countryCode: '{{countryCode|UK}}', multiplecountrycode: ['{{countryCode|UK}}'] },
        PURCHASE_ESIM: { partnerCode: '{{partnerCode}}', planCode: '{{planCode}}', quantity: '1', email: '{{email}}' },
      },
      requiredConfigFields: [
        { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Airhub API username' },
        { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Airhub API password' },
        { name: 'partnerCode', label: 'Partner Code', type: 'text', required: false, placeholder: 'Optional partner code' },
        { name: 'countryCode', label: 'Country Code', type: 'text', required: false, placeholder: 'UK (default)' },
      ],
      isSystemTemplate: true,
    },
    provider: {
      code: 'AIRHUB',
      name: 'Airhub Outreach (Staging)',
      type: 'CUSTOM',
      adapterStrategy: 'TEMPLATE',
      authType: 'credentials',
      tokenPlacement: 'BEARER_HEADER',
      environment: 'staging',
      status: 'TESTING',
      priority: 10,
      config: { ...STAGING_NOTE, providerMode: 'TEMPLATE', templateDriven: true, numericFields: ['partnerCode'], configurationFields: [
        { key: 'username', label: 'Username', type: 'text', required: true, secret: false, group: 'credentials', placeholder: 'Airhub API username' },
        { key: 'password', label: 'Password', type: 'password', required: true, secret: true, group: 'credentials', placeholder: 'Airhub API password' },
        { key: 'environment', label: 'Environment', type: 'select', required: true, group: 'environment', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
        { key: 'partnerCode', label: 'Partner Code', type: 'text', required: false, group: 'config', placeholder: 'Optional partner code' },
        { key: 'countryCode', label: 'Country Code', type: 'text', required: false, group: 'testing', default: 'UK', placeholder: 'UK (default)' },
      ] },
      supportsESIM: true, supportsTopUp: true, supportsQRCode: true,
    },
  },

  // ── Rakuten Mobile ─────────────────────────────────────────────────────────
  {
    name: 'Rakuten Mobile',
    match: { name: 'Rakuten Mobile' },
    data: {
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
        sku: 'id', name: 'name', price_usd: 'price.value', currency: 'price.currency',
        validity_days: 'validity_days', data_gb: 'data_usage_allowance_gb',
        country: 'coverage_region', type: 'coverage_type',
        supported_countries: 'supported_countries',
      },
      defaultCapabilities: { supportsESIM: true, supportsQRCode: true, supportsUsage: true },
      responseMappings: {
        tokenPath: 'result.access_token',
        iccidPath: 'result.iccid',
        reservationIdPath: 'result.reservationId',
        reservationIdFallbackPaths: ['result.id', 'result.reservation_id'],
        reservationExpiresAtPath: 'result.expired_at',
        activationCodePath: 'result.activationCode',
        providerOrderIdPath: 'result.packageId',
        packageIdPath: 'result.packageId',
      },
      endpointMappings: {
        AUTH_LOGIN: 'POST /client/auth/token',
        GET_PLANS: 'GET /client/package-templates/all?page=1&pageSize=50&inventoryId=4ca24027-e2fc-4abc-9c06-7cee7a56cc61&coverageType=&coverageRegion=&includeCountries=true',
        INITIATE_PURCHASE: 'POST /purchase/initiate-purchase',
        FULFILL_PURCHASE: 'POST /purchase/fulfill-purchase?reservationId={reservationId}',
        CANCEL_PURCHASE: 'POST /purchase/cancel-purchase?reservationId={reservationId}',
        PURCHASE_INITIATE: 'POST /purchase/initiate-purchase',
        PURCHASE_FULFILL: 'POST /purchase/fulfill-purchase?reservationId={{reservationId}}',
        GET_PACKAGES: 'GET /client/packages',
        GET_USAGE: 'GET /client/packages/usage?iccid={{iccid}}',
        GET_READY_SIMS: 'GET /client/sim-registries/ready?inventoryId={{inventoryId}}',
        GET_INVENTORIES: 'GET /client/inventory/all?page=0&pageSize=100',
        GET_CDRS: 'GET /network-access/cdrs?iccid={{iccid}}',
      },
      requestMappings: {
        AUTH_LOGIN: { username: '{{username}}', password: '{{password}}' },
        PURCHASE_INITIATE: { packageTemplateId: '{{planCode}}' },
      },
      requiredConfigFields: [
        { name: 'username', label: 'API Username', type: 'text', required: true, placeholder: 'Rakuten API username' },
        { name: 'password', label: 'API Password', type: 'password', required: true, placeholder: 'Rakuten API password' },
      ],
      isSystemTemplate: true,
    },
    provider: {
      code: 'RAKUTEN',
      name: 'Rakuten Mobile (Staging)',
      type: 'CUSTOM',
      adapterStrategy: 'TEMPLATE',
      authType: 'credentials',
      tokenPlacement: 'BEARER_HEADER',
      environment: 'staging',
      status: 'TESTING',
      priority: 20,
      config: { ...STAGING_NOTE, providerMode: 'TEMPLATE', templateDriven: true, purchaseWorkflow: 'TWO_STEP_RESERVATION_FULFILLMENT', configurationFields: [
        { key: 'username', label: 'API Username', type: 'text', required: true, secret: false, group: 'credentials', placeholder: 'Rakuten API username' },
        { key: 'password', label: 'API Password', type: 'password', required: true, secret: true, group: 'credentials', placeholder: 'Rakuten API password' },
        { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, group: 'endpoints', default: 'https://stg-api-b2b-prepaid-sim.rmb-lab.jp/v1/esim' },
        { key: 'authPath', label: 'Auth Path', type: 'readonly', required: true, group: 'endpoints', default: '/client/auth/token' },
      ] },
      supportsESIM: true, supportsQRCode: true, supportsUsage: true,
    },
  },

  // ── Choice Wireless ─────────────────────────────────────────────────────────
  {
    name: 'Choice Wireless',
    match: { name: 'Choice Wireless' },
    data: {
      description: 'Choice Wireless eSIM provider (VirtuoLink/PSASOFT). Auth: https://psa.virtuolink.org/WebService/accounts/getaccounts. IMSI API: https://lpaasapi.psasoft.com:443/account/v03_09. Supports eSIM activation, bundle management, IMSI operations.',
      connectorType: 'STANDARD',
      authType: 'credentials',
      tokenPlacement: 'URL_PATH',
      isSystemTemplate: true,
    },
    provider: {
      code: 'CHOICE',
      name: 'Choice Wireless (Staging)',
      type: 'CHOICE',
      adapterStrategy: 'CHOICE',
      environment: 'staging',
      status: 'TESTING',
      priority: 30,
      authType: 'credentials',
      tokenPlacement: 'URL_PATH',
      apiBaseUrl: 'https://lpaasapi.psasoft.com:443',
      authUrl: 'https://psa.virtuolink.org/WebService/accounts/getaccounts',
      apiVersion: 'v03_09',
      config: {
        ...STAGING_NOTE,
        authBaseUrl: 'https://psa.virtuolink.org',
        _legacyConnector: true,
        _note: 'Auth: POST https://psa.virtuolink.org/WebService/accounts/getaccounts with {request:{un,pw,command:"accounts_getaccounts"}} → response.response.data[0].token. IMSI base: https://lpaasapi.psasoft.com:443/account/v03_09/<func>/<token>.',
      },
      supportsESIM: true, supportsUsage: true, supportsTopUp: true,
    },
  },
]

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== OneSim Africa — Staging Provider Setup ===\n')

  for (const tpl of templates) {
    // 1. Upsert template
    const existingTpl = await prisma.providerTemplate.findFirst({ where: tpl.match })
    let templateId

    if (existingTpl) {
      await prisma.providerTemplate.update({ where: { id: existingTpl.id }, data: tpl.data })
      templateId = existingTpl.id
      console.log(`  ✓ Template "${tpl.name}" updated`)
    } else {
      const created = await prisma.providerTemplate.create({ data: { ...tpl.data, name: tpl.name } })
      templateId = created.id
      console.log(`  ✓ Template "${tpl.name}" created`)
    }

    // 2. Upsert provider
    const existingProv = await prisma.provider.findUnique({ where: { code: tpl.provider.code } })

    if (existingProv) {
      await prisma.provider.update({
        where: { code: tpl.provider.code },
        data: {
          ...tpl.provider,
          providerTemplateId: templateId,
          endpointMappings: tpl.data.endpointMappings || undefined,
          requestMappings: tpl.data.requestMappings || undefined,
          responseMappings: tpl.data.responseMappings || undefined,
          requiredConfigFields: tpl.data.requiredConfigFields || undefined,
          optionalConfigFields: tpl.data.optionalConfigFields || undefined,
          fieldMappings: tpl.data.defaultFieldMappings || undefined,
        },
      })
      console.log(`  ✓ Provider "${tpl.provider.code}" updated`)
    } else {
      await prisma.provider.create({
        data: {
          ...tpl.provider,
          providerTemplateId: templateId,
          endpointMappings: tpl.data.endpointMappings || undefined,
          requestMappings: tpl.data.requestMappings || undefined,
          responseMappings: tpl.data.responseMappings || undefined,
          requiredConfigFields: tpl.data.requiredConfigFields || undefined,
          optionalConfigFields: tpl.data.optionalConfigFields || undefined,
          fieldMappings: tpl.data.defaultFieldMappings || undefined,
          apiBaseUrl: tpl.data.defaultBaseUrl || null,
          authUrl: tpl.data.defaultAuthUrl || null,
          planListPath: tpl.data.defaultPlanListPath || null,
          activationPath: tpl.data.defaultActivationPath || null,
          responseListKey: tpl.data.defaultResponseListKey || null,
        },
      })
      console.log(`  ✓ Provider "${tpl.provider.code}" created`)
    }
  }

  console.log('\n=== Staging providers ready ===')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Admin → Providers → view each provider')
  console.log('  2. For Airhub: set apiBaseUrl + credentials, Test Connection, Sync Plans')
  console.log('  3. For Rakuten: set apiBaseUrl + credentials, Test Connection, Sync Plans')
  console.log('  4. For Choice: set apiBaseUrl + apiToken, Test Connection, Sync Plans')
  console.log('  5. Admin → Provider Audit → run certification')
  console.log('  6. To switch to production: update apiBaseUrl, environment=production, status=ACTIVE')
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
