/**
 * OneSim Africa — Provider Config Trace
 *
 * Shows exactly where every configuration field comes from for a given provider code.
 * Usage: node scripts/provider-trace.mjs CHOICE
 *        node scripts/provider-trace.mjs AIRHUB
 *        node scripts/provider-trace.mjs RAKUTEN
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const code = (process.argv[2] || '').toUpperCase()
if (!code) { console.log('Usage: node scripts/provider-trace.mjs <CODE>'); process.exit(1) }

async function main() {
  console.log(`\n=== Provider Trace: ${code} ===\n`)

  const providers = await prisma.provider.findMany({
    where: { code },
    orderBy: { createdAt: 'asc' },
    include: { providerTemplate: true },
  })

  if (providers.length === 0) {
    console.log(`No providers found with code "${code}"`)
    await prisma.$disconnect()
    return
  }

  // Show all records (for duplicate detection)
  console.log(`Records found: ${providers.length}`)
  for (const p of providers) {
    console.log(`  ID=${p.id.slice(-8)} Status=${p.status} Created=${p.createdAt.toISOString().slice(0, 10)}`)
  }
  console.log('')

  // Use the first non-archived or newest
  const p = providers.find(pr => pr.status !== 'ARCHIVED') || providers[providers.length - 1]
  const tpl = p.providerTemplate

  console.log('─── Provider Record ───')
  console.log(`  ID:                ${p.id}`)
  console.log(`  Code:              ${p.code}`)
  console.log(`  Name:              ${p.name}`)
  console.log(`  Status:            ${p.status}`)
  console.log(`  Environment:       ${p.environment}`)
  console.log(`  Type:              ${p.type}`)
  console.log(`  Adapter Strategy:  ${p.adapterStrategy || '(not set)'}`)
  console.log(`  Auth Type:         ${p.authType || '(not set)'}`)
  console.log(`  Token Placement:   ${p.tokenPlacement || '(not set)'}`)
  console.log(`  Auth URL:          ${p.authUrl || '(not set)'}`)
  console.log(`  API Base URL:      ${p.apiBaseUrl || '(not set)'}`)
  console.log(`  API Version:       ${p.apiVersion || '(not set)'}`)
  console.log(`  Template ID:       ${p.providerTemplateId || '(not set)'}`)
  console.log('')

  if (tpl) {
    console.log('─── Linked Template ───')
    console.log(`  ID:                ${tpl.id}`)
    console.log(`  Name:              ${tpl.name}`)
    console.log(`  Connector Type:    ${tpl.connectorType}`)
    console.log(`  Auth Type:         ${tpl.authType}`)
    console.log(`  Token Placement:   ${tpl.tokenPlacement}`)
    console.log(`  Default Base URL:  ${tpl.defaultBaseUrl || '(not set)'}`)
    console.log(`  Default Auth URL:  ${tpl.defaultAuthUrl || '(not set)'}`)
    console.log(`  Response List Key: ${tpl.defaultResponseListKey || '(not set)'}`)
    if (tpl.endpointMappings) {
      const eps = Object.keys(tpl.endpointMappings)
      console.log(`  Endpoint Mappings: ${eps.length} keys`)
      for (const key of ['AUTH_LOGIN', 'GET_PLANS', 'PURCHASE_ESIM']) {
        if (eps.includes(key)) console.log(`    ${key}: ${tpl.endpointMappings[key]}`)
      }
    }
    if (tpl.responseMappings) console.log(`  Response Mappings: ${JSON.stringify(tpl.responseMappings)}`)
    if (tpl.requestMappings) {
      const rms = Object.keys(tpl.requestMappings)
      console.log(`  Request Mappings:  ${rms.length} keys`)
    }
    console.log('')
  }

  // Determine effective auth URL
  console.log('─── Effective Auth URL Resolution ───')
  let authUrl = null
  let source = ''

  // 1. Check provider record authUrl
  if (p.authUrl) {
    authUrl = p.authUrl
    source = 'provider.authUrl (direct field on provider record)'
  }
  // 2. Check template endpointMappings AUTH_LOGIN
  else if (tpl?.endpointMappings?.AUTH_LOGIN) {
    const ep = tpl.endpointMappings.AUTH_LOGIN.split(' ')
    const path = ep.length === 2 ? ep[1] : ep[0]
    authUrl = tpl.defaultBaseUrl ? `${tpl.defaultBaseUrl}${path}` : path
    source = `template.endpointMappings.AUTH_LOGIN + template.defaultBaseUrl`
  }
  // 3. Check template defaultAuthUrl
  else if (tpl?.defaultAuthUrl) {
    authUrl = tpl.defaultAuthUrl
    source = 'template.defaultAuthUrl'
  }
  // 4. Check provider endpointMappings AUTH_LOGIN
  else if (p.endpointMappings?.AUTH_LOGIN) {
    const ep = p.endpointMappings.AUTH_LOGIN.split(' ')
    const path = ep.length === 2 ? ep[1] : ep[0]
    authUrl = p.apiBaseUrl ? `${p.apiBaseUrl}${path}` : path
    source = 'provider.endpointMappings.AUTH_LOGIN + provider.apiBaseUrl'
  }
  // 5. Fallback
  else {
    authUrl = `${p.apiBaseUrl || '(no base URL)'}/... (no auth endpoint configured)`
    source = 'fallback (no auth path found)'
  }

  console.log(`  Final Auth URL:    ${authUrl}`)
  console.log(`  Source:            ${source}`)
  console.log('')

  // Show isTemplateDrivenProvider result
  const isTemplate = (() => {
    if (p.adapterStrategy === 'TEMPLATE') return true
    if (p.adapterStrategy && !['TEMPLATE', 'MOCK'].includes(p.adapterStrategy)) return false
    if (p.providerTemplateId) return true
    if (p.type === 'TEMPLATE') return true
    const cfg = (p.config || {})
    if (cfg.providerMode === 'TEMPLATE') return true
    if (cfg.templateDriven === true) return true
    return false
  })()

  console.log('─── Adapter Selection ───')
  console.log(`  isTemplateDriven:  ${isTemplate}`)
  console.log(`  Adapter Used:      ${isTemplate ? 'TemplateProviderAdapter' : 'UrlTokenConnector / Connector'}`)

  if (isTemplate && p.adapterStrategy === 'CHOICE') {
    console.log('  ⚠ WARNING: Strategy=CHOICE but isTemplateDriven=true! Auth will use wrong URL.')
    console.log('  Fix: Remove providerTemplateId from Choice, or set adapterStrategy=TEMPLATE with correct endpointMappings.')
  }
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
