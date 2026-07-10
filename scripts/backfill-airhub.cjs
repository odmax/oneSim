const { PrismaClient } = require('@prisma/client')
const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply')

async function main() {
  const p = new PrismaClient()
  const airhub = await p.provider.findFirst({
    where: { code: 'AIRHUB' },
    select: { id: true, name: true, code: true, config: true, requestMappings: true },
  })

  if (!airhub) { console.log('ERROR: AirHub provider not found'); process.exit(1) }
  if (airhub.code !== 'AIRHUB') { console.log(`ERROR: Expected AIRHUB got ${airhub.code}`); process.exit(1) }

  const existingConfig = airhub.config || {}
  const updatedConfig = { ...existingConfig }
  let changed = false

  if (updatedConfig.partnerCode == null) { updatedConfig.partnerCode = 200652387; changed = true }
  if (updatedConfig.flag == null) { updatedConfig.flag = 6; changed = true }
  if (updatedConfig.countryCode == null) { updatedConfig.countryCode = 'String'; changed = true }
  if (!updatedConfig.multiplecountrycode || !Array.isArray(updatedConfig.multiplecountrycode)) {
    updatedConfig.multiplecountrycode = ['UK']; changed = true
  }

  const currentRM = airhub.requestMappings || {}
  const updatedRM = {
    ...currentRM,
    GET_PLANS: {
      partnerCode: '{{config.partnerCode}}',
      flag: '{{config.flag|6}}',
      countryCode: '{{config.countryCode|String}}',
      multiplecountrycode: '{{config.multiplecountrycode|UK}}',
    },
  }

  console.log(DRY_RUN ? 'DRY RUN — no changes applied' : 'APPLY MODE — changes will be applied')
  console.log(`Provider: ${airhub.name} (${airhub.id})`)
  console.log(`Config keys before: ${Object.keys(existingConfig).join(', ') || 'none'}`)
  console.log(`Config keys after:  ${Object.keys(updatedConfig).join(', ') || 'none'}`)
  console.log(`  partnerCode: ${updatedConfig.partnerCode} ${changed && updatedConfig.partnerCode != null ? '(new)' : ''}`)
  console.log(`  flag: ${updatedConfig.flag} ${changed ? '(new)' : ''}`)
  console.log(`  countryCode: ${updatedConfig.countryCode} ${changed ? '(new)' : ''}`)
  console.log(`  multiplecountrycode: ${JSON.stringify(updatedConfig.multiplecountrycode)} ${changed ? '(new)' : ''}`)

  // Verify no other providers affected
  const choice = await p.provider.findFirst({
    where: { code: 'CHOICE' },
    select: { config: true },
  })
  if (choice?.config?.partnerCode != null) { console.log('WARNING: Choice provider has partnerCode in config'); process.exit(1) }

  if (DRY_RUN) {
    console.log('Run with --apply to apply changes.')
  } else {
    await p.provider.update({ where: { id: airhub.id }, data: { config: updatedConfig, requestMappings: updatedRM } })
    console.log('Applied.')
  }
  await p.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
