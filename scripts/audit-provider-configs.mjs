/**
 * OneSim Africa — Provider Configuration Audit
 *
 * Scans all providers and templates, reports missing fields,
 * duplicate codes, and shows the effective auth/test URLs.
 *
 * Usage: node scripts/audit-provider-configs.mjs
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const REQUIRED_TEMPLATE_FIELDS = ['name', 'connectorType', 'authType', 'tokenPlacement']
const REQUIRED_PROVIDER_FIELDS = ['name', 'code', 'type', 'adapterStrategy', 'authType']

async function main() {
  console.log('\n=== OneSim Africa — Provider Configuration Audit ===\n')

  // ── Templates ──
  const templates = await prisma.providerTemplate.findMany({ orderBy: { name: 'asc' } })
  console.log(`Templates (${templates.length}):`)
  console.log('─'.repeat(60))
  for (const t of templates) {
    const missing = REQUIRED_TEMPLATE_FIELDS.filter(f => !t[f])
    const hasEP = t.endpointMappings ? Object.keys(t.endpointMappings).length : 0
    const hasRM = t.requestMappings ? Object.keys(t.requestMappings).length : 0
    console.log(`  ${t.name.padEnd(25)} ${'✓'.repeat(REQUIRED_TEMPLATE_FIELDS.length - missing.length)}${'✗'.repeat(missing.length)}`)
    if (missing.length) console.log(`    Missing: ${missing.join(', ')}`)
    console.log(`    Endpoint mappings: ${hasEP} · Request mappings: ${hasRM ? '✓' : '—'}`)
    if (t.defaultBaseUrl) console.log(`    Default base URL: ${t.defaultBaseUrl}`)
    if (t.defaultAuthUrl) console.log(`    Default auth URL: ${t.defaultAuthUrl}`)
  }

  // ── Providers ──
  const providers = await prisma.provider.findMany({
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    include: { providerTemplate: { select: { name: true } } },
  })
  console.log(`\nProviders (${providers.length}):`)
  console.log('─'.repeat(80))

  // Check for duplicate codes
  const codes = providers.map(p => p.code)
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i)
  if (dupes.length > 0) console.log(`\n⚠ DUPLICATE CODES: ${[...new Set(dupes)].join(', ')}\n`)

  for (const p of providers) {
    const missing = []
    if (!p.adapterStrategy) missing.push('adapterStrategy')
    if (!p.authType) missing.push('authType')
    if (p.adapterStrategy === 'TEMPLATE' && !p.endpointMappings) missing.push('endpointMappings')
    if (p.adapterStrategy !== 'TEMPLATE' && p.adapterStrategy !== 'MOCK' && !p.apiBaseUrl) missing.push('apiBaseUrl')
    if (p.adapterStrategy === 'CHOICE' && !p.authUrl) missing.push('authUrl (Choice needs separate auth URL)')

    const authUrl = p.authUrl || p.providerTemplate?.name || '(not set)'
    const testUrl = p.apiBaseUrl ? `${p.apiBaseUrl}/...${p.adapterStrategy === 'CHOICE' ? '/account/v03_09/bundle_templates/{token}' : ''}` : '(not set)'

    console.log(`\n  ${p.code.padEnd(10)} ${p.name}`)
    console.log(`    Strategy: ${p.adapterStrategy || '—'} · Type: ${p.type} · Auth: ${p.authType || '—'}`)
    console.log(`    Template: ${p.providerTemplate?.name || '—'}`)
    console.log(`    Auth URL:    ${authUrl}`)
    console.log(`    API Base:    ${p.apiBaseUrl || '—'}`)
    console.log(`    Token placement: ${p.tokenPlacement || '—'}`)
    console.log(`    Test URL:    ${testUrl}`)
    if (missing.length) console.log(`    ⚠ Missing: ${missing.join(', ')}`)
  }

  // ── Summary ──
  console.log('\n=== Summary ===')
  console.log(`  Templates: ${templates.length}`)
  console.log(`  Providers: ${providers.length}`)
  console.log(`  Duplicate codes: ${dupes.length > 0 ? [...new Set(dupes)].join(', ') : 'None'}`)
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
