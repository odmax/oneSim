/**
 * OneSim Africa — iBASIS Provider Setup
 *
 * Creates/updates the IBASIS provider record wired to the dedicated
 * IbasisConnector (adapterStrategy=IBASIS).
 *
 * Authentication: static API token sent as `Authorization: Token <token>`
 * (never Bearer). The base URL and all behavior come from provider
 * configuration — nothing is hard-coded in the connector source.
 *
 * Configuration fields:
 *   - baseUrl           (required)  iBASIS Consumer Offer API base URL
 *   - apiToken          (required)  stored encrypted at provider.apiToken
 *   - requestTimeoutMs  (optional)  default 15000
 *   - environment       (optional)  production | staging | sandbox
 *   - defaultCurrency   (optional)  default USD
 *
 * Connection test endpoint: GET /api/v1/plans (documented read-only; preferred
 * over /health). Base URL already contains /api/v1.
 *
 * Idempotent: safe to run multiple times. Upserts by code.
 *
 * Usage:
 *   node scripts/seed-ibasis-provider.mjs
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('\n=== OneSim Africa — iBASIS Provider Setup ===\n')

  const existing = await prisma.provider.findUnique({ where: { code: 'IBASIS' } })

  const providerData = {
    name: 'iBASIS (Staging)',
    code: 'IBASIS',
    type: 'CUSTOM',
    adapterStrategy: 'IBASIS',
    authType: 'api_token',
    tokenPlacement: 'HEADER',
    apiVersion: 'v1',
    environment: 'staging',
    status: 'TESTING',
    priority: 40,
    config: {
      _productionUrlPending: true,
      _note: 'Set baseUrl + apiToken before testing connection. Auth header: Authorization: Token <token>. Base URL already includes /api/v1.',
      _setupVia: 'seed-ibasis-provider.mjs',
      baseUrl: 'https://staging.2mobilesconnect.com/api/v1',
      requestTimeoutMs: 15000,
      environment: 'staging',
      defaultCurrency: 'USD',
      configurationFields: [
        { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, secret: false, group: 'endpoints', placeholder: 'https://staging.2mobilesconnect.com/api/v1' },
        { key: 'apiToken', label: 'API Token', type: 'password', required: true, secret: true, group: 'credentials', placeholder: 'iBASIS API token', helperText: 'Sent as Authorization: Token <token>. Stored encrypted.' },
        { key: 'requestTimeoutMs', label: 'Request Timeout (ms)', type: 'number', required: false, group: 'config', default: '15000' },
        { key: 'environment', label: 'Environment', type: 'select', required: false, group: 'config', options: ['production', 'staging', 'sandbox'] },
        { key: 'defaultCurrency', label: 'Default Currency', type: 'text', required: false, group: 'config', default: 'USD' },
      ],
    },
    endpointMappings: {
      INVENTORY_LIST: 'GET /api/v1/inventory/sims',
      PLAN_LIST: 'GET /api/v1/plans',
    },
    enabledCapabilities: ['AUTH', 'INVENTORY', 'ESIM', 'CATALOG_SYNC', 'PLAN_SYNC', 'PURCHASE', 'STATUS', 'SUSPEND', 'RESUME', 'WEBHOOKS'],
    supportsESIM: true,
    supportsSuspendResume: true,
  }

  if (existing) {
    await prisma.provider.update({ where: { code: 'IBASIS' }, data: providerData })
    console.log('  ✓ Provider "IBASIS" updated')
  } else {
    await prisma.provider.create({ data: providerData })
    console.log('  ✓ Provider "IBASIS" created')
  }

  console.log('\n=== iBASIS provider ready ===')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Admin → Providers → iBASIS')
  console.log('  2. Set baseUrl + apiToken, then Test Connection (GET /api/v1/plans, read-only)')
  console.log('  3. Plan sync and purchase arrive in Phase 2')
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
