/**
 * AirHub Purchase Payload Preview (DRY RUN)
 * Usage: npx tsx scripts/test-airhub-purchase-payload.ts --dry-run
 */
import { PrismaClient } from '@prisma/client'
import { decryptToken } from '../src/lib/encryption'

const prisma = new PrismaClient()

function mask(s: string): string { return s ? s.slice(0, 4) + '****' : 'none' }

async function main() {
  const provider = await prisma.provider.findFirst({ where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } } })
  if (!provider) { console.log('No active AirHub provider found'); process.exit(1) }

  const cfg = (provider.config as any) || {}
  const partnerCode = cfg.partnerCode
  if (!partnerCode) { console.log('No partnerCode configured'); process.exit(1) }

  // Find a plan to preview
  const plan = await prisma.providerPackage.findFirst({
    where: { providerId: provider.id, isAvailable: true, costPrice: { gt: 0 } },
    select: { providerPlanId: true, name: true, costPrice: true, currency: true },
  })
  if (!plan) { console.log('No plans found for AirHub'); process.exit(1) }

  const token = provider.apiToken ? mask(decryptToken(provider.apiToken)) : 'none'

  console.log('=== AirHub Purchase Payload Preview (DRY RUN) ===')
  console.log(`Provider: ${provider.name} (${provider.code})`)
  console.log(`Token: Bearer ${token}`)
  console.log(`Endpoint: POST ${provider.apiBaseUrl || 'https://api.airhubapp.com'}/api/ESIM/PurhaseSim`)
  console.log(`\nPayload:`)
  console.log(JSON.stringify({
    partnerCode,
    planCode: plan.providerPlanId,
    unique_order_id: `onesim-dryrun-${Date.now()}`,
    // travelDate: not included — add when subscriber travel date is available
  }, null, 2))
  console.log(`\nPlan: ${plan.name} (${plan.providerPlanId})`)
  console.log(`Cost: ${plan.costPrice} ${plan.currency}`)
  console.log('\n⚠ Dry run — no API call was made.')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
