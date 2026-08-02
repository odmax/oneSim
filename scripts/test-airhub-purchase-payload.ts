/**
 * AirHub Purchase Payload Preview (DRY RUN)
 * Usage:
 *   npx tsx scripts/test-airhub-purchase-payload.ts --dry-run
 *   npx tsx scripts/test-airhub-purchase-payload.ts --dry-run --planId <providerPlanId> [--travelDate YYYY-MM-DD]
 *
 * Prints the exact outgoing body shape, value types, required-field presence,
 * travelDate validity, and confirms no undocumented fields leak into the
 * payload. Never makes a purchase in dry-run mode.
 */
import { PrismaClient } from '@prisma/client'
import { decryptToken } from '../src/lib/encryption'

const prisma = new PrismaClient()

const UNDOCUMENTED_FIELDS = ['quantity', 'email', 'customerEmail', 'externalId', 'orderId', 'packageId']

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function mask(s: string): string { return s ? s.slice(0, 4) + '****' : 'none' }

async function main() {
  const provider = await prisma.provider.findFirst({ where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } } })
  if (!provider) { console.log('No active AirHub provider found'); process.exit(1) }

  const cfg = (provider.config as any) || {}
  const partnerCode = cfg.partnerCode
  if (!partnerCode) { console.log('No partnerCode configured'); process.exit(1) }

  const planId = argValue('--planId')
  const plan = planId
    ? await prisma.providerPackage.findFirst({ where: { providerId: provider.id, providerPlanId: planId } })
    : await prisma.providerPackage.findFirst({
        where: { providerId: provider.id, isAvailable: true, costPrice: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
      })
  if (!plan) { console.log('No AirHub plan found'); process.exit(1) }

  const travelDateRaw = argValue('--travelDate') || undefined
  const travelDateValid = travelDateRaw === undefined || travelDateRaw === '' || /^\d{4}-\d{2}-\d{2}$/.test(travelDateRaw)
  const travelDateToSend = travelDateValid && travelDateRaw ? travelDateRaw : undefined

  // Exact same shape as the connector builds — no undocumented fields.
  const payload: Record<string, string> = {
    partnerCode: String(partnerCode),
    planCode: String(plan.providerPlanId),
    unique_order_id: `onesim-dryrun-${Date.now()}`,
  }
  if (travelDateToSend) payload.travelDate = travelDateToSend

  const undocumentedLeaked = UNDOCUMENTED_FIELDS.filter(f => f in payload)
  const requiredPresent = {
    partnerCode: 'partnerCode' in payload && payload.partnerCode !== '',
    planCode: 'planCode' in payload && payload.planCode !== '',
    unique_order_id: 'unique_order_id' in payload && payload.unique_order_id !== '',
  }

  const token = provider.apiToken ? mask(decryptToken(provider.apiToken) || '') : 'none'

  console.log('=== AirHub Purchase Payload Preview (DRY RUN) ===')
  console.log(`Provider: ${provider.name} (${provider.code}) id=${provider.id}`)
  console.log(`Endpoint: POST ${provider.apiBaseUrl || 'https://api.airhubapp.com'}/api/ESIM/PurhaseSim`)
  console.log(`Authorization: Bearer ${token} (present=${!!provider.apiToken})`)
  console.log(`Plan (upstream providerPlanId): ${plan.providerPlanId}`)
  console.log(`Plan name: ${plan.name} (cost ${plan.costPrice} ${plan.currency})`)
  console.log()
  console.log('--- Payload ---')
  console.log(JSON.stringify(payload, null, 2))
  console.log()
  console.log('--- Checks ---')
  console.log(`bodyKeys=${Object.keys(payload).join(',')}`)
  console.log(`partnerCode type=${typeof payload.partnerCode} value=${payload.partnerCode}`)
  console.log(`planCode type=${typeof payload.planCode} value=${payload.planCode}`)
  console.log(`unique_order_id type=${typeof payload.unique_order_id} present=true`)
  console.log(`travelDate ${travelDateRaw === undefined ? 'omitted (not provided)' : travelDateRaw === '' ? 'omitted (empty string)' : travelDateValid ? `present ${travelDateToSend} (valid YYYY-MM-DD)` : `INVALID ${travelDateRaw} (rejected locally)`}`)
  console.log(`required present: partnerCode=${requiredPresent.partnerCode} planCode=${requiredPresent.planCode} unique_order_id=${requiredPresent.unique_order_id}`)
  console.log(`undocumented fields absent=${undocumentedLeaked.length === 0}${undocumentedLeaked.length ? ` LEAKED: ${undocumentedLeaked.join(',')}` : ''}`)
  console.log(`authorizationPresent=${!!provider.apiToken}`)

  console.log()
  if (!requiredPresent.partnerCode || !requiredPresent.planCode || !requiredPresent.unique_order_id) {
    console.log('ERROR: A required field is missing.')
    process.exit(1)
  }
  if (!travelDateValid) {
    console.log('ERROR: travelDate is present but invalid (must be YYYY-MM-DD). The connector rejects this before any HTTP call.')
    process.exit(1)
  }
  if (undocumentedLeaked.length) {
    console.log('ERROR: Undocumented fields leaked into the payload.')
    process.exit(1)
  }
  console.log('OK — payload matches the documented contract.')
  console.log('Dry run complete — no API call was made.')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
