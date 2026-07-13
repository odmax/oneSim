const { PrismaClient } = require('@prisma/client')
const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply')

async function main() {
  const p = new PrismaClient()
  const airhub = await p.provider.findFirst({
    where: { code: 'AIRHUB' },
    select: { id: true, name: true, code: true, adapterStrategy: true, tokenPlacement: true, apiBaseUrl: true, authUrl: true, apiToken: true, config: true, requestMappings: true },
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

  // Ensure GET_PLANS countryCode is ""
  const currentRM = airhub.requestMappings || {}
  const plansMapping = (currentRM.GET_PLANS || {})
  if (plansMapping.countryCode !== '{{config.countryCode|}}') {
    changes.push('GET_PLANS countryCode → "" empty string default')
    update.requestMappings = {
      ...currentRM,
      GET_PLANS: {
        ...plansMapping,
        countryCode: '{{config.countryCode|}}',
      },
    }
  }

  const config = airhub.config || {}
  if (config.countryCode !== '') {
    changes.push(`config.countryCode: "${config.countryCode}" → ""`)
    update.config = { ...config, countryCode: '' }
  }

  // Remove stale template metadata
  if (config.providerMode || config.templateDriven) {
    const cleaned = { ...config }
    delete cleaned.providerMode
    delete cleaned.templateDriven
    update.config = cleaned
    changes.push('Removed stale providerMode/templateDriven')
  }

  const hasToken = !!airhub.apiToken
  console.log(DRY_RUN ? 'DRY RUN' : 'APPLY MODE')
  console.log(`Provider: ${airhub.name} (${airhub.id})`)
  console.log(`  adapterStrategy: ${airhub.adapterStrategy}`)
  console.log(`  tokenPlacement: ${airhub.tokenPlacement}`)
  console.log(`  apiBaseUrl: ${airhub.apiBaseUrl}`)
  console.log(`  authUrl: ${airhub.authUrl}`)
  console.log(`  tokenStored: ${hasToken}`)
  console.log(`  config.countryCode: "${config.countryCode}"`)
  console.log(`  GET_PLANS.countryCode template: ${plansMapping.countryCode}`)
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
