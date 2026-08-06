/**
 * Backfill canonical travel-date policy fields on ProviderPackage.
 * AirHub default: REQUIRED + FLEXIBLE + leadDays=0
 *
 * Modes: --dry-run | --apply [--provider-code=X] [--provider-package-id=X]
 */

import { prisma } from '../src/lib/prisma'

// Provider-level template defaults for TravelDate behavior
const PROVIDER_DEFAULTS: Record<string, { activationPolicy: string; travelDateRequirement: string; travelDateLeadDays: number }> = {
  AIRHUB: { activationPolicy: 'FLEXIBLE', travelDateRequirement: 'REQUIRED', travelDateLeadDays: 0 },
  CHOICE: { activationPolicy: 'IMMEDIATE', travelDateRequirement: 'NOT_REQUIRED', travelDateLeadDays: 0 },
  IBASIS: { activationPolicy: 'IMMEDIATE', travelDateRequirement: 'NOT_REQUIRED', travelDateLeadDays: 0 },
  TELNA: { activationPolicy: 'IMMEDIATE', travelDateRequirement: 'NOT_REQUIRED', travelDateLeadDays: 0 },
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const codeIdx = args.indexOf('--provider-code')
  const codeFilter = codeIdx >= 0 ? args[codeIdx + 1]?.toUpperCase() : undefined
  const idIdx = args.indexOf('--provider-package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--provider-code=X] [--provider-package-id=X]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = {}
  if (codeFilter) where.provider = { code: { equals: codeFilter, mode: 'insensitive' } }
  if (idFilter) where.id = idFilter

  const packages = await prisma.providerPackage.findMany({
    where,
    include: { provider: { select: { code: true } } },
    orderBy: { name: 'asc' },
  })

  let inspected = packages.length
  let explicitProvider = 0
  let templateDefaultApplied = 0
  let adminOverridesPreserved = 0
  let optionalCount = 0
  let requiredCount = 0
  let notRequiredCount = 0
  let ambiguous = 0
  let updated = 0

  for (const pp of packages) {
    const providerCode = pp.provider?.code?.toUpperCase() || ''
    const defaults = PROVIDER_DEFAULTS[providerCode]

    // Preserve existing Admin overrides
    if (pp.travelDateSource === 'ADMIN_OVERRIDE') {
      adminOverridesPreserved++
      continue
    }

    // Try explicit plan metadata first
    const raw = pp.providerRawData as any
    let resolved: typeof defaults | null = null
    let source = ''

    if (raw?.__requiresTravelDate !== undefined) {
      resolved = {
        activationPolicy: 'FLEXIBLE',
        travelDateRequirement: raw.__requiresTravelDate ? 'REQUIRED' : 'NOT_REQUIRED',
        travelDateLeadDays: 0,
      }
      source = 'PROVIDER'
      explicitProvider++
    }

    // Fall back to provider template default
    if (!resolved && defaults) {
      resolved = defaults
      source = 'TEMPLATE'
      templateDefaultApplied++
    }

    if (!resolved) {
      ambiguous++
      console.log(`  [AMBIGUOUS] ${pp.name} (no defaults for ${providerCode})`)
      continue
    }

    if (resolved.travelDateRequirement === 'REQUIRED') requiredCount++
    else if (resolved.travelDateRequirement === 'OPTIONAL') optionalCount++
    else notRequiredCount++

    if (apply) {
      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: {
          activationPolicy: resolved.activationPolicy,
          travelDateRequirement: resolved.travelDateRequirement,
          travelDateLeadDays: resolved.travelDateLeadDays,
          travelDateSource: source,
        },
      })
      updated++
      console.log(`  [UPDATED] ${pp.name}: ${resolved.travelDateRequirement} (source=${source})`)
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Inspected:              ${inspected}`)
  console.log(`Explicit provider:      ${explicitProvider}`)
  console.log(`Template default:       ${templateDefaultApplied}`)
  console.log(`Admin overrides:        ${adminOverridesPreserved}`)
  console.log(`Required:               ${requiredCount}`)
  console.log(`Optional:               ${optionalCount}`)
  console.log(`Not required:           ${notRequiredCount}`)
  console.log(`Ambiguous:              ${ambiguous}`)
  if (apply) console.log(`Updated:                ${updated}`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
