const { PrismaClient } = require('@prisma/client')
const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply')

async function main() {
  const p = new PrismaClient()
  const airhub = await p.provider.findFirst({
    where: { code: 'AIRHUB' },
    select: { id: true, name: true, code: true, adapterStrategy: true, tokenPlacement: true, apiBaseUrl: true, authUrl: true, apiToken: true, environment: true, config: true, requestMappings: true },
  })

  if (!airhub) { console.log('ERROR: AirHub not found'); process.exit(1) }
  if (airhub.code !== 'AIRHUB') { console.log('ERROR: Wrong provider'); process.exit(1) }

  const changes = []
  const update = {}

  if (airhub.adapterStrategy !== 'AIRHUB') {
    changes.push(`adapterStrategy: ${airhub.adapterStrategy} → AIRHUB`)
    update.adapterStrategy = 'AIRHUB'
  }

  if (airhub.tokenPlacement !== 'BEARER_HEADER') {
    changes.push(`tokenPlacement: ${airhub.tokenPlacement} → BEARER_HEADER`)
    update.tokenPlacement = 'BEARER_HEADER'
  }

  if (airhub.apiBaseUrl !== 'https://api.airhubapp.com') {
    changes.push(`apiBaseUrl: ${airhub.apiBaseUrl} → https://api.airhubapp.com`)
    update.apiBaseUrl = 'https://api.airhubapp.com'
  }

  if (airhub.authUrl !== '/api/Authentication/UserLogin') {
    changes.push(`authUrl: ${airhub.authUrl} → /api/Authentication/UserLogin`)
    update.authUrl = '/api/Authentication/UserLogin'
  }

  // Fix GET_PLANS mappings
  const currentRM = airhub.requestMappings || {}
  const plansMapping = currentRM.GET_PLANS || {}
  if (plansMapping.countryCode !== '{{config.countryCode|}}') {
    changes.push('GET_PLANS countryCode → "" default')
    update.requestMappings = {
      ...currentRM,
      GET_PLANS: { ...plansMapping, countryCode: '{{config.countryCode|}}' },
    }
  }

  // Fix config: upstreamEnvironment, countryCode, remove stale keys
  const config = airhub.config || {}
  const cleaned = { ...config }
  delete cleaned.providerMode
  delete cleaned.templateDriven
  delete cleaned._productionUrlPending
  delete cleaned._setupVia
  delete cleaned._note

  if (!cleaned.upstreamEnvironment) {
    cleaned.upstreamEnvironment = 'production'
    changes.push('config.upstreamEnvironment → production')
  }
  if (cleaned.authEnvironmentAtAuth !== cleaned.upstreamEnvironment) {
    cleaned.authEnvironmentAtAuth = cleaned.upstreamEnvironment
  }
  if (cleaned.countryCode !== '') {
    cleaned.countryCode = ''
    changes.push('config.countryCode → ""')
  }
  update.config = cleaned

  const hasToken = !!airhub.apiToken
  console.log(DRY_RUN ? 'DRY RUN' : 'APPLY MODE')
  console.log(`Provider: ${airhub.name} (${airhub.id})`)
  console.log(`  environment: ${airhub.environment}`)
  console.log(`  adapterStrategy: ${airhub.adapterStrategy}`)
  console.log(`  tokenPlacement: ${airhub.tokenPlacement}`)
  console.log(`  apiBaseUrl: ${airhub.apiBaseUrl}`)
  console.log(`  authUrl: ${airhub.authUrl}`)
  console.log(`  tokenStored: ${hasToken}`)
  console.log(`  upstreamEnvironment: ${cleaned.upstreamEnvironment}`)
  console.log(`  countryCode: "${cleaned.countryCode}"`)
  console.log(`  providerMode removed: ${!!config.providerMode}`)
  console.log(`  Changes: ${changes.length > 0 ? changes.join('; ') : 'none needed'}`)

  if (DRY_RUN) {
    console.log('Run with --apply to apply changes.')
  } else if (changes.length > 0) {
    await p.provider.update({ where: { id: airhub.id }, data: update })
    console.log('Applied.')
  }

  await p.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
