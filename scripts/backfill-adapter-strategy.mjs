/**
 * Migration: Backfill adapterStrategy for existing providers.
 *
 * - If type=CUSTOM and adapterStrategy is null → CUSTOM_HTTP
 * - If provider has config.planListPath and responseListKey → TEMPLATE_SKU
 * - If type=CHOICE → TEMPLATE_SKU (Choice is a template/SKU provider)
 * - If type=IBASIS → REST_CATALOG (iBASIS has a REST catalog)
 * - If type=MOCK → MOCK
 * - Otherwise → strategy from type or null
 */
import { prisma } from '../src/lib/prisma'

async function backfillAdapterStrategies() {
  const providers = await prisma.provider.findMany()
  let updated = 0

  for (const p of providers) {
    if (p.adapterStrategy) continue // Already set

    let strategy: string | null = null
    const config = p.config as any

    // Smart detection: has planListPath + responseListKey → TEMPLATE_SKU
    if (config?.planListPath && config?.responseListKey) {
      strategy = 'TEMPLATE_SKU'
    } else switch (p.type) {
      case 'CUSTOM':
        strategy = 'CUSTOM_HTTP'
        break
      case 'CHOICE':
        strategy = 'TEMPLATE_SKU'
        break
      case 'IBASIS':
        strategy = 'REST_CATALOG'
        break
      case 'MOCK':
        strategy = 'MOCK'
        break
      default:
        strategy = null
    }

    if (strategy) {
      await prisma.provider.update({
        where: { id: p.id },
        data: { adapterStrategy: strategy },
      })
      console.log(`  [${p.code}] ${p.type} → adapterStrategy: ${strategy}`)
      updated++
    } else {
      console.log(`  [${p.code}] ${p.type} → SKIPPED (no strategy determined)`)
    }
  }

  console.log(`\nDone. ${updated} providers updated.`)
}

backfillAdapterStrategies()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
