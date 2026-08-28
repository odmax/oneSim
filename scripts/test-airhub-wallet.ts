/**
 * AirHub Wallet Live Test
 * Usage: npx tsx scripts/test-airhub-wallet.ts
 *
 * Calls the canonical fetchAirhubWallet() server action. Authentication is the
 * canonical source of partnerCode: if it is missing from config, the login
 * response derives and persists it before the wallet call. This script does NOT
 * pre-abort when config.partnerCode is absent. Never prints credentials or raw
 * tokens.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const provider = await prisma.provider.findFirst({ where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } } })
  if (!provider) { console.log('No active AirHub provider found'); process.exit(1) }

  const hasCredentials = !!((provider.config as any)?.username || (provider.config as any)?.userName)
    && !!((provider.config as any)?.password || (provider.config as any)?.pass)

  console.log(`Provider: ${provider.name} (${provider.code})`)
  console.log(`Credentials present: ${hasCredentials}`)

  // Fetch wallet via the server action (auth derives/persists partnerCode; the
  // wallet read follows on the same connector instance).
  const { fetchAirhubWallet } = await import('../src/lib/actions/airhub-wallet')
  const result = await fetchAirhubWallet(provider.id, 'MANUAL')

  console.log(`\nResult: ${result.success ? 'SUCCESS' : 'FAILED'}`)
  if (result.success) {
    console.log(`Balance: $${result.data?.balance?.toFixed(2)} ${result.data?.currency}`)
    console.log(`Last synced: ${result.data?.lastSyncedAt || 'N/A'}`)
  } else {
    // The string may contain a partner-code context but never credentials/tokens.
    console.log(`Error: ${(result as any).error || 'Unknown error'}`)
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })