/**
 * OneSim Africa — Repair Provider Configurations
 *
 * Idempotently fixes AirHub, Rakuten, and Choice provider records.
 * Removes duplicate codes (archives extras).
 * Updates templates and providers with correct configs.
 *
 * Usage: node scripts/repair-provider-configs.mjs
 *        node scripts/repair-provider-configs.mjs --dry-run
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const DRY_RUN = process.argv.includes('--dry-run')

const STAGING_NOTE = {
  _productionUrlPending: true,
  _note: 'Production URL not configured. Set apiBaseUrl to production endpoint before going live.',
  _setupVia: 'repair-provider-configs.mjs',
}

const CONFIGS = {
  AIRHUB: {
    name: 'Airhub Outreach (Staging)',
    type: 'CUSTOM',
    adapterStrategy: 'TEMPLATE',
    authType: 'credentials',
    tokenPlacement: 'BEARER_HEADER',
    environment: 'staging',
    status: 'TESTING',
    priority: 10,
    apiBaseUrl: null,  // must be set by admin
    authUrl: null,     // from endpointMappings
    apiVersion: 'v1',
    config: { ...STAGING_NOTE, providerMode: 'TEMPLATE', templateDriven: true },
    supportsESIM: true, supportsTopUp: true, supportsQRCode: true,
    templateName: 'Airhub Outreach',
  },
  RAKUTEN: {
    name: 'Rakuten Mobile (Staging)',
    type: 'CUSTOM',
    adapterStrategy: 'TEMPLATE',
    authType: 'credentials',
    tokenPlacement: 'BEARER_HEADER',
    environment: 'staging',
    status: 'TESTING',
    priority: 20,
    apiBaseUrl: 'https://stg-api-b2b-prepaid-sim.rmb-lab.jp/v1/esim',
    authUrl: null,  // from endpointMappings: /client/auth/token
    apiVersion: 'v1',
    config: { ...STAGING_NOTE, providerMode: 'TEMPLATE', templateDriven: true },
    supportsESIM: true, supportsQRCode: true, supportsUsage: true,
    templateName: 'Rakuten Mobile',
  },
  CHOICE: {
    name: 'Choice Wireless (Staging)',
    type: 'CHOICE',
    adapterStrategy: 'CHOICE',
    authType: 'credentials',
    tokenPlacement: 'URL_PATH',
    environment: 'staging',
    status: 'TESTING',
    priority: 30,
    apiBaseUrl: 'https://lpaasapi.psasoft.com:443',
    authUrl: 'https://psa.virtuolink.org/WebService/accounts/getaccounts',
    apiVersion: 'v03_09',
    config: {
      ...STAGING_NOTE,
      authBaseUrl: 'https://psa.virtuolink.org',
      _legacyConnector: true,
      _note: 'Auth: POST to authUrl with {request:{un,pw,command:"accounts_getaccounts"}} → response.response.data[0].token. IMSI API base: apiBaseUrl.',
    },
    fieldMappings: {
      activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL',
      // NOTE: no userId here — a real Choice account id is persisted by the
      // auth flow (provider.config.userId). The legacy 'onesim' placeholder is
      // intentionally NOT written.
    },
    supportsESIM: true, supportsUsage: true, supportsTopUp: true,
    templateName: 'Choice Wireless',
  },
}

async function main() {
  console.log(`\n=== OneSim Africa — Repair Provider Configs ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'} ===\n`)

  // 1. Deduplicate providers by code
  const allProviders = await prisma.provider.findMany({ orderBy: { createdAt: 'asc' } })
  const byCode = new Map()
  for (const p of allProviders) {
    const existing = byCode.get(p.code)
    if (!existing) { byCode.set(p.code, [p]); continue }
    existing.push(p)
  }

  for (const [code, records] of byCode) {
    if (records.length <= 1) continue
    // Keep the first (oldest) record, archive the rest
    const keep = records[0]
    const toArchive = records.slice(1)
    console.log(`  ${code}: ${records.length} records — keeping ID=${keep.id.slice(-8)}, archiving ${toArchive.length} duplicate(s)`)
    for (const dup of toArchive) {
      if (DRY_RUN) continue
      await prisma.provider.update({
        where: { id: dup.id },
        data: { status: 'ARCHIVED', config: { ...(dup.config || {}), _duplicateOf: keep.id, _archivedByRepair: true } },
      })
      console.log(`    Archived duplicate ID=${dup.id.slice(-8)}`)
    }
  }

  // 2. Upsert templates and providers for each known config
  for (const [code, cfg] of Object.entries(CONFIGS)) {
    // Template
    const tpl = cfg.templateName ? await prisma.providerTemplate.findFirst({ where: { name: cfg.templateName } }) : null

    // Provider — upsert by code
    const existing = await prisma.provider.findFirst({
      where: { code, status: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'asc' },
    })

    const providerData = {
      name: cfg.name,
      type: cfg.type,
      adapterStrategy: cfg.adapterStrategy,
      authType: cfg.authType,
      tokenPlacement: cfg.tokenPlacement,
      environment: cfg.environment,
      status: cfg.status,
      priority: cfg.priority,
      apiBaseUrl: cfg.apiBaseUrl,
      authUrl: cfg.authUrl,
      apiVersion: cfg.apiVersion,
      config: cfg.config,
      supportsESIM: cfg.supportsESIM,
      supportsTopUp: cfg.supportsTopUp,
      supportsQRCode: cfg.supportsQRCode ?? false,
      supportsUsage: cfg.supportsUsage ?? false,
      providerTemplateId: tpl?.id || null,
    }

    if (!existing) {
      if (DRY_RUN) {
        console.log(`  ${code}: Would create provider`)
      } else {
        await prisma.provider.create({ data: { code, ...providerData } })
        console.log(`  ${code}: Created`)
      }
    } else {
      // Merge fieldMappings to preserve existing values
      if (cfg.fieldMappings) {
        const existingFm = (existing.fieldMappings && typeof existing.fieldMappings === 'object') ? existing.fieldMappings : {}
        providerData.fieldMappings = { ...cfg.fieldMappings, ...existingFm }
        console.log(`  ${code}: Merging fieldMappings — existing keys: ${Object.keys(existingFm).join(', ') || '(none)'}, new keys: ${Object.keys(cfg.fieldMappings).join(', ')}`)
      }
      if (DRY_RUN) {
        console.log(`  ${code}: Would update (existing ID=${existing.id.slice(-8)})`)
      } else {
        await prisma.provider.update({ where: { id: existing.id }, data: providerData })
        console.log(`  ${code}: Updated (ID=${existing.id.slice(-8)})`)
      }
    }
  }

  // 3. Update seed script instruction
  console.log('\n=== To re-run full seed with latest configs ===')
  console.log('  node scripts/seed-staging-providers.mjs')
  console.log('')
  console.log('=== Done ===')
  if (DRY_RUN) console.log('  Run without --dry-run to apply changes.\n')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
