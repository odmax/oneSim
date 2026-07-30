/**
 * AirHub Wallet Live Test
 * Usage: npx tsx scripts/test-airhub-wallet.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const provider = await prisma.provider.findFirst({ where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } } })
  if (!provider) { console.log('No active AirHub provider found'); process.exit(1) }

  const cfg = (provider.config as any) || {}
  const partnerCode = cfg.partnerCode
  if (!partnerCode) { console.log('No partnerCode configured'); process.exit(1) }

  console.log(`Provider: ${provider.name} (${provider.code})`)
  console.log(`Partner code: ${partnerCode}`)

  // Fetch wallet via the server action
  const { fetchAirhubWallet } = await import('../src/lib/actions/airhub-wallet')
  const result = await fetchAirhubWallet(provider.id, 'MANUAL')

  console.log(`\nResult: ${result.success ? 'SUCCESS' : 'FAILED'}`)
  if (result.success) {
    console.log(`Balance: $${result.data?.balance?.toFixed(2)} ${result.data?.currency}`)
    console.log(`Last synced: ${result.data?.lastSyncedAt || 'N/A'}`)
  } else {
    console.log(`Error: ${result.error}`)
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
