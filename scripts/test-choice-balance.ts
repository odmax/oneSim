/**
 * Choice Prepaid Balance Test
 *
 * Usage:
 *   npx tsx scripts/test-choice-balance.ts --dry-run   # hostname + path only, no API call
 *   npx tsx scripts/test-choice-balance.ts             # live call (sanitized keys + balance only)
 *
 * Set CHOICE_BALANCE_DIAGNOSTICS_ENABLED=true to also emit sanitized
 * [CHOICE_BALANCE_RESPONSE] diagnostics from the connector.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function urlHostname(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return baseUrl }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  const provider = await prisma.provider.findFirst({
    where: { code: 'CHOICE', status: { in: ['ACTIVE', 'TESTING'] } },
  })
  if (!provider) {
    console.log('No active Choice provider found')
    await prisma.$disconnect()
    process.exit(1)
  }

  const cfg = (provider.config as any) || {}
  const balancePath = cfg.balancePath || '/account/v03_09/prepaid_balance'
  const tokenPresent = !!(provider.apiToken && String(provider.apiToken).length > 0)
  const host = urlHostname(provider.apiBaseUrl || '')

  console.log(`Provider: ${provider.name} (${provider.code})`)
  console.log(`Hostname: ${host}`)
  console.log(`Balance path (token omitted): ${balancePath}`)
  console.log(`Token present: ${tokenPresent}`)
  console.log(`Configured currency: ${cfg.currency || '(none — defaults to USD fallback)'}`)
  console.log(`Diagnostics env: ${process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED === 'true' ? 'on' : 'off'}`)

  if (dryRun) {
    console.log('\nDry run — no API call made.')
    await prisma.$disconnect()
    return
  }

  if (!tokenPresent) {
    console.log('\nNo token configured — aborting live call.')
    await prisma.$disconnect()
    process.exit(1)
  }

  const { buildConnectorFromProvider } = await import('../src/lib/providers/connectors/connector-factory')
  const connector = await buildConnectorFromProvider(provider.id)
  if (!connector || typeof connector.getBalance !== 'function') {
    console.log('\nConnector does not expose getBalance()')
    await prisma.$disconnect()
    process.exit(1)
  }

  const result = await connector.getBalance()

  console.log(`\nResult: ${result.success ? 'SUCCESS' : 'FAILED'}`)
  if (result.success) {
    console.log(`Balance: ${result.data?.balance} ${result.data?.currency}`)
    console.log(`Account: ${result.data?.accountId || 'N/A'} (${result.data?.accountName || 'N/A'})`)
  } else {
    console.log(`Error code: ${result.error?.code}`)
    console.log(`Error: ${result.error?.message}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
