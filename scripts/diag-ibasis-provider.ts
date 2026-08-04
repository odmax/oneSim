/**
 * iBASIS provider diagnostic script.
 *
 * Modes:
 *   npx tsx scripts/diag-ibasis-provider.ts --provider-id=<id>
 *   npx tsx scripts/diag-ibasis-provider.ts --provider-code=IBASIS
 *
 * Reports: provider config, auth, inventory, plans, purchases.
 * Never prints tokens, credentials, activation codes, or full ICCIDs.
 */

import { prisma } from '../src/lib/prisma'
import { IbasisConnector } from '../src/lib/providers/connectors/ibasis-connector'

function mask(s: string | null | undefined, show = 4): string {
  if (!s) return '(none)'
  if (s.length <= show * 2) return '*'.repeat(s.length)
  return s.slice(0, show) + '...' + s.slice(-show)
}

async function main() {
  const args = process.argv.slice(2)
  const providerId = args.find(a => a.startsWith('--provider-id='))?.split('=')[1]
  const providerCode = args.find(a => a.startsWith('--provider-code='))?.split('=')[1] || 'IBASIS'

  const where: any = {}
  if (providerId) where.id = providerId
  else where.code = providerCode.toUpperCase()

  const provider = await prisma.provider.findFirst({ where })
  if (!provider) { console.error(`Provider not found: ${providerId || providerCode}`); process.exit(1) }

  console.log('=== iBASIS Provider Diagnostic ===\n')
  console.log(`ID:           ${provider.id}`)
  console.log(`Code:         ${provider.code}`)
  console.log(`Type:         ${provider.type}`)
  console.log(`Status:       ${provider.status}`)
  console.log(`Environment:  ${provider.environment}`)
  console.log(`Adapter:      ${provider.adapterStrategy || '(none)'}`)
  console.log(`Base URL:     ${provider.apiBaseUrl || '(not set)'}`)
  console.log(`Token:        ${provider.apiToken ? `configured (${mask(provider.apiToken)})` : 'MISSING'}`)

  const caps = (provider.enabledCapabilities || []) as string[]
  console.log(`Capabilities: ${caps.length ? caps.join(', ') : '(defaults from code)'}`)

  const cfg = (provider.config || {}) as any
  console.log(`Inventory path:    ${cfg.inventoryPath || '/api/v1/inventory/sims'}`)
  console.log(`Plans path:        ${cfg.plansPath || '/api/v1/plans'}`)
  console.log(`Subscribers path:  ${cfg.subscribersPath || '/api/v1/subscribers'}`)
  console.log(`Subscriptions path: ${cfg.subscriptionsPath || '/api/v1/subscriptions'}`)
  console.log(`Activations path:  ${cfg.activationsPath || '/api/v1/subscriptions/activations'}`)

  // Health
  console.log(`\nLast success:  ${provider.lastSuccessfulConnection?.toISOString() || 'never'}`)
  console.log(`Last failure:  ${provider.lastFailedConnection?.toISOString() || 'never'}`)
  console.log(`Error count:   ${provider.errorCount ?? 0}`)
  console.log(`Last error:    ${provider.lastError?.slice(0, 100) || 'none'}`)
  console.log(`Success rate:  ${provider.activationSuccessRate != null ? provider.activationSuccessRate.toFixed(1) + '%' : 'N/A'}`)

  // Packages
  const packageCount = await prisma.providerPackage.count({ where: { providerId: provider.id } })
  const retailPackageCount = await prisma.eSIMPackage.count({ where: { providerId: provider.id, isActive: true } })
  console.log(`\nProvider packages: ${packageCount}`)
  console.log(`Retail packages:   ${retailPackageCount}`)

  // Connection test
  if (!provider.apiBaseUrl || !provider.apiToken) {
    console.log('\n⚠  Cannot test connection: base URL or token missing')
    prisma.$disconnect(); return
  }

  console.log('\n--- Connection Test ---')
  try {
    const connector = new IbasisConnector(provider.id)

    // Token state
    const tokenState = await connector.getTokenState()
    console.log(`Token:       ${tokenState.tokenPresent ? 'Present' : 'Absent'}`)

    // Auth
    const ensured = await connector.ensureAuthenticated()
    console.log(`Auth:        ${ensured.success ? 'OK' : 'FAILED: ' + (ensured.error?.message || 'unknown')}`)

    // Test connection
    const test = await connector.testConnection()
    console.log(`Connection:  ${test.success ? 'OK' : 'FAILED'} ${test.success ? `(${test.data?.latencyMs}ms)` : ''}`)

    // Inventory
    if (caps.includes('INVENTORY') || true) {
      const inv = await connector.listInventorySims({ limit: 5 })
      if (inv.success) {
        console.log(`\nInventory:   ${inv.data?.total ?? '?'} SIMs (sample: ${inv.data?.items?.length ?? 0})`)
      } else {
        console.log(`\nInventory:   FAILED — ${inv.error?.message?.slice(0, 100)}`)
      }
    }

    // Plans
    if (caps.includes('PLAN_SYNC') || true) {
      const plans = await connector.syncPlans()
      if (plans.success) {
        console.log(`Plans:       ${plans.data?.length ?? 0} plans synced`)
      } else {
        console.log(`Plans:       FAILED — ${plans.error?.message?.slice(0, 100)}`)
      }
    }
  } catch (e: any) {
    console.log(`Connection test failed: ${e.message?.slice(0, 200)}`)
  }

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
