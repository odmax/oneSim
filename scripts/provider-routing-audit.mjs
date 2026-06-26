/**
 * OneSim Africa — Provider Routing Audit
 *
 * Traces every provider's full routing path and reports any issues.
 * Usage: node scripts/provider-routing-audit.mjs
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

function routeProvider(provider) {
  const adapterStrategy = provider.adapterStrategy
  const providerType = provider.type
  const hasTemplateId = !!provider.providerTemplateId

  // Mirror the actual isTemplateDrivenProvider logic
  let isTemplate = false
  if (adapterStrategy === 'TEMPLATE') isTemplate = true
  else if (adapterStrategy && !['TEMPLATE', 'MOCK'].includes(adapterStrategy)) isTemplate = false
  else if (hasTemplateId) isTemplate = true
  else if (provider.config?.providerMode === 'TEMPLATE') isTemplate = true
  else if (provider.config?.templateDriven === true) isTemplate = true

  const adapterName = isTemplate ? 'TemplateProviderAdapter' : 'Connector (UrlTokenConnector / RestCatalogConnector)'

  // Mirror resolveConnectorType
  let connectorType = 'REST_CATALOG'
  if (adapterStrategy === 'CHOICE') connectorType = 'URL_TOKEN'
  else if (adapterStrategy === 'URL_TOKEN') connectorType = 'URL_TOKEN'
  else if (adapterStrategy === 'HEADER_TOKEN') connectorType = 'HEADER_TOKEN'
  else if (adapterStrategy === 'REST_CATALOG') connectorType = 'REST_CATALOG'
  else if (adapterStrategy === 'STANDARD') connectorType = 'STANDARD'

  const templateUsed = isTemplate ? 'YES' : 'NO'
  const correctConnector = adapterStrategy === 'CHOICE' ? 'URL_TOKEN' :
    adapterStrategy === 'URL_TOKEN' ? 'URL_TOKEN' : connectorType

  let issues = []
  if (adapterStrategy === 'CHOICE' && isTemplate) issues.push('CRITICAL: Choice routed to TemplateProviderAdapter!')
  if (adapterStrategy === 'CHOICE' && connectorType !== 'URL_TOKEN') issues.push('CRITICAL: Choice connector is not URL_TOKEN!')
  if (adapterStrategy === 'TEMPLATE' && !isTemplate) issues.push('CRITICAL: Template not routed to TemplateProviderAdapter!')
  if (adapterStrategy === 'CHOICE' && hasTemplateId) issues.push('WARNING: Choice has providerTemplateId — should be removed')
  if (adapterStrategy === 'TEMPLATE' && !hasTemplateId) issues.push('INFO: Template provider has no template linked')
  if (!adapterStrategy) issues.push('WARNING: No adapterStrategy set')

  return { adapterStrategy, providerType, hasTemplateId, isTemplate, adapterName, connectorType, templateUsed, issues }
}

async function main() {
  console.log('\n=== OneSim Africa — Provider Routing Audit ===\n')

  const providers = await prisma.provider.findMany({
    orderBy: [{ code: 'asc' }, { createdAt: 'asc' }],
    include: { providerTemplate: { select: { name: true } } },
  })

  // Check duplicates
  const codes = providers.map(p => p.code)
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i)
  if (dupes.length > 0) {
    console.log(`⚠ DUPLICATE CODES FOUND: ${[...new Set(dupes)].join(', ')}`)
    for (const code of [...new Set(dupes)]) {
      const records = providers.filter(p => p.code === code)
      console.log(`  ${code}: ${records.length} records`)
      for (const r of records) {
        console.log(`    ID=${r.id.slice(-8)} strategy=${r.adapterStrategy} status=${r.status} created=${r.createdAt.toISOString().slice(0,10)}`)
      }
    }
    console.log('')
  }

  console.log('Provider Routing Report:')
  console.log('─'.repeat(100))
  console.log(`${'Code'.padEnd(12)} ${'Strategy'.padEnd(14)} ${'Adapter'.padEnd(35)} ${'Connector'.padEnd(16)} ${'Template'.padEnd(10)} ${'Issues'}`)
  console.log('─'.repeat(100))

  let criticalIssues = 0
  for (const p of providers) {
    const r = routeProvider(p)
    const status = r.issues.some(i => i.startsWith('CRITICAL')) ? '⚠' : r.issues.length > 0 ? '!' : '✓'
    if (r.issues.some(i => i.startsWith('CRITICAL'))) criticalIssues++
    console.log(`${p.code.padEnd(12)} ${r.adapterStrategy?.padEnd(14) || '(none)'.padEnd(14)} ${r.adapterName.padEnd(35)} ${r.connectorType.padEnd(16)} ${r.templateUsed.padEnd(10)} ${status}`)
    for (const issue of r.issues) {
      console.log(`  ${' '.repeat(12)} ${issue}`)
    }
  }

  console.log('─'.repeat(100))
  console.log(`\nCritical issues: ${criticalIssues}`)
  console.log(`Duplicate codes: ${dupes.length > 0 ? [...new Set(dupes)].join(', ') : 'None'}`)
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
