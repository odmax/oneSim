/* eslint-disable no-console */
/**
 * US-Matrix package validity repair — DRY-RUN by default.
 *
 * Corrects CURRENT catalog records only (ProviderPackage + linked retail
 * ESIMPackage) to the source-backed validity: raw.limit + raw.limitType "day".
 * NEVER touches historical orders/snapshots/completed eSIM expiry/wallet/
 * attempts/SKUs/pricing and NEVER calls the provider.
 *
 * Options:
 *   --apply   execute the writes (default is read-only dry-run)
 *
 * Deterministic, idempotent: a second --apply pass reports zero would-update rows.
 */
import { PrismaClient } from '@prisma/client'
import { planUsMatrixValidityRepair } from '../src/lib/services/catalog/usmatrix-validity-repair'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  console.log(`[USMATRIX_REPAIR] mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const providers = await prisma.provider.findMany({
    where: { OR: [{ code: 'USMATRIX' }, { adapterStrategy: 'USMATRIX' }] },
    select: { id: true },
  })
  const providerIds = providers.map((p) => p.id)
  console.log(`USMATRIX_PROVIDER_COUNT=${providerIds.length}`)
  if (providerIds.length === 0) {
    console.log('HISTORICAL_ORDER_UPDATE_COUNT=0')
    console.log('PROVIDER_CALL_COUNT=0')
    await prisma.$disconnect()
    return
  }

  const packages = await prisma.providerPackage.findMany({
    where: { providerId: { in: providerIds } },
    select: { id: true, validityDays: true, providerRawData: true },
  })
  const retail = await prisma.eSIMPackage.findMany({
    where: { providerPackageId: { in: packages.map((p) => p.id) } },
    select: { id: true, validityDays: true, providerPackageId: true },
  })

  const plan = planUsMatrixValidityRepair(packages, retail, providerIds.length)

  const c = plan.counters
  console.log(`PROVIDER_PACKAGE_SCANNED=${c.PROVIDER_PACKAGE_SCANNED}`)
  console.log(`PROVIDER_PACKAGE_ELIGIBLE=${c.PROVIDER_PACKAGE_ELIGIBLE}`)
  console.log(`PROVIDER_PACKAGE_WOULD_UPDATE=${c.PROVIDER_PACKAGE_WOULD_UPDATE}`)
  console.log(`PROVIDER_PACKAGE_ALREADY_CORRECT=${c.PROVIDER_PACKAGE_ALREADY_CORRECT}`)
  console.log(`PROVIDER_PACKAGE_INVALID_SOURCE=${c.PROVIDER_PACKAGE_INVALID_SOURCE}`)
  console.log(`RETAIL_PACKAGE_SCANNED=${c.RETAIL_PACKAGE_SCANNED}`)
  console.log(`RETAIL_PACKAGE_WOULD_UPDATE=${c.RETAIL_PACKAGE_WOULD_UPDATE}`)
  console.log(`RETAIL_PACKAGE_ALREADY_CORRECT=${c.RETAIL_PACKAGE_ALREADY_CORRECT}`)
  console.log(`HISTORICAL_ORDER_UPDATE_COUNT=${c.HISTORICAL_ORDER_UPDATE_COUNT}`)
  console.log(`PROVIDER_CALL_COUNT=${c.PROVIDER_CALL_COUNT}`)

  if (!apply) {
    console.log('DRY_RUN=true  — pass --apply to write source-backed validity values')
    await prisma.$disconnect()
    return
  }

  const { applyUsMatrixValidityRepair } = await import('../src/lib/services/catalog/usmatrix-validity-repair')
  const { applied } = await applyUsMatrixValidityRepair(
    { $transaction: (ops) => prisma.$transaction(ops), providerPackage: prisma.providerPackage, eSIMPackage: prisma.eSIMPackage },
    plan,
  )
  console.log(`APPLIED_UPDATE_COUNT=${applied}`)
  console.log('HISTORICAL_ORDER_UPDATE_COUNT=0 (never touched)')
  console.log('PROVIDER_CALL_COUNT=0 (never called)')

  await prisma.$disconnect()
}

main().catch(async (e: any) => {
  console.error(`[USMATRIX_REPAIR] fatal=${e?.message || e}`)
  await prisma.$disconnect()
  process.exit(1)
})