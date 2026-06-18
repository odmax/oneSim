/**
 * Cleanup duplicate ProviderPackage records.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-provider-packages.mjs        # dry-run
 *   node scripts/cleanup-duplicate-provider-packages.mjs --apply # actually delete
 *
 * Strategy: for each (providerId, providerPlanId) group:
 *   1. Prefer keeping the record that has a linked ESIMPackage (publishedAs)
 *   2. Otherwise keep the oldest record
 *   3. Delete the rest
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const DRY_RUN = !process.argv.includes('--apply')

async function main() {
  console.log(`\n=== Duplicate ProviderPackage Cleanup ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'} ===\n`)

  // Find all duplicates grouped by providerId + providerPlanId
  const duplicates = await prisma.$queryRawUnsafe(`
    SELECT id, "providerId", "providerPlanId", "createdAt", "name",
      EXISTS (SELECT 1 FROM esim_packages ep WHERE ep."providerPackageId" = pp.id) AS has_esim
    FROM provider_packages pp
    WHERE "providerPlanId" IS NOT NULL AND "providerPlanId" != ''
    ORDER BY "providerId", "providerPlanId", "createdAt" ASC
  `)

  // Group in-memory
  const groups = new Map()
  for (const row of duplicates) {
    const key = `${row.providerId}|${row.providerPlanId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  let totalGroups = 0
  let totalDeleted = 0
  let totalPreserved = 0
  let totalErrors = 0

  for (const [key, rows] of groups) {
    if (rows.length <= 1) continue
    totalGroups++

    // Sort: linked ESIMPackage first, then oldest
    rows.sort((a, b) => {
      if (a.has_esim && !b.has_esim) return -1
      if (!a.has_esim && b.has_esim) return 1
      return new Date(a.createdAt) - new Date(b.createdAt)
    })

    const keep = rows[0]
    const toDelete = rows.slice(1)

    console.log(`\n[${key}] "${keep.name}" — ${rows.length} records, keeping ID=${keep.id}${keep.has_esim ? ' (has linked ESIMPackage)' : ''}`)

    for (const del of toDelete) {
      console.log(`  DELETE ID=${del.id} "${del.name}" (created ${del.createdAt.toISOString?.() || del.createdAt})`)
      totalDeleted++

      if (!DRY_RUN) {
        try {
          // Check if this duplicate has linked ESIMPackages that need re-linking
          if (del.has_esim) {
            const linkedEsims = await prisma.eSIMPackage.findMany({
              where: { providerPackageId: del.id },
            })
            for (const esim of linkedEsims) {
              await prisma.eSIMPackage.update({
                where: { id: esim.id },
                data: { providerPackageId: keep.id },
              })
              console.log(`    -> Relinked ESIMPackage ${esim.id} to keep record ${keep.id}`)
            }
          }

          // Delete the duplicate provider package
          // Use raw SQL to avoid Prisma's safe-delete checks
          await prisma.providerPackage.delete({ where: { id: del.id } })
          console.log(`    -> Deleted`)
        } catch (e) {
          console.error(`    -> Error: ${e.message}`)
          totalErrors++
        }
      }
    }
    totalPreserved++
  }

  console.log(`\n=== Summary ===`)
  console.log(`  Groups with duplicates: ${totalGroups}`)
  console.log(`  Records kept:          ${totalPreserved}`)
  console.log(`  Records to delete:     ${totalDeleted}`)
  console.log(`  Errors:                ${totalErrors}`)
  console.log(`  Mode:                  ${DRY_RUN ? 'DRY RUN (pass --apply to execute)' : 'APPLIED'}`)
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
