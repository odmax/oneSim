/**
 * Repair script: promote provider-returned installation/QR data into the
 * normalized eSIM install columns and set installationStatus=READY.
 *
 * For each candidate eSIM (missing usable install data, non-terminal
 * purchase) it:
 *   1. Whitelist-extracts install fields from the stored providerResponse.
 *   2. For providers that support QR retrieval, calls adapter.getQRCode
 *      (a read-only provider call — NO purchase/activation is ever made).
 *   3. Fills missing columns only (never overwrites existing valid data).
 *
 * Never modifies the order, wallet, or provider purchase records. Never
 * prints raw provider credentials or full install payloads.
 *
 * Usage:
 *   npx tsx scripts/repair-esim-installation-data.ts --dry-run
 *   npx tsx scripts/repair-esim-installation-data.ts --apply
 *   npx tsx scripts/repair-esim-installation-data.ts --dry-run --esim-id=<id>
 *   npx tsx scripts/repair-esim-installation-data.ts --apply --provider-code=AIRHUB
 */

import { prisma } from '../src/lib/prisma'
import { hasUsableInstallData, extractInstallDataFromProviderResponse, mergeInstallData, normalizeConnectorInstallData, type InstallDataFields } from '../src/lib/esim/installation-data'
import { getAdapterForType } from '../src/lib/providers/adapter-manager'

function getFlag(name: string): string | undefined {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  return arg ? arg.split('=').slice(1).join('=') : undefined
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const apply = process.argv.includes('--apply')
  const esimId = getFlag('esim-id')
  const providerCode = getFlag('provider-code')?.toUpperCase()

  if (!dryRun && !apply) {
    console.log('Usage: npx tsx scripts/repair-esim-installation-data.ts --dry-run | --apply [--esim-id=<id>] [--provider-code=<code>]')
    process.exit(1)
  }

  console.log(dryRun ? '=== DRY RUN (no writes, read-only provider calls only) ===' : '=== APPLYING ===')

  // Resolve provider-code filter to provider ids
  let providerIdFilter: string[] | undefined
  if (providerCode) {
    const providers = await prisma.provider.findMany({ where: { code: providerCode }, select: { id: true } })
    if (providers.length === 0) {
      console.log(`  No provider found with code '${providerCode}'. Aborting.`)
      process.exit(1)
    }
    providerIdFilter = providers.map(p => p.id)
    console.log(`  Provider code filter: ${providerCode} (${providerIdFilter.length} provider row(s))`)
  }

  const baseWhere: any = {
    purchase: { status: { notIn: ['FAILED', 'CANCELLED', 'REFUNDED'] } },
  }
  if (esimId) baseWhere.id = esimId
  if (providerIdFilter) baseWhere.purchase = { ...baseWhere.purchase, package: { providerId: { in: providerIdFilter } } }

  const candidates = await prisma.eSIM.findMany({
    where: baseWhere,
    include: { purchase: { select: { package: { select: { providerId: true } }, status: true } } },
    orderBy: { createdAt: 'desc' },
  })

  let scanned = 0
  let alreadyReady = 0
  let repaired = 0
  let stillPending = 0
  let notSupported = 0
  let failed = 0

  for (const esim of candidates) {
    scanned++

    const current: InstallDataFields = {
      activationCode: esim.activationCode,
      qrCodeUrl: esim.qrCodeUrl,
      qrCode: esim.qrCode,
      smdpAddress: esim.smdpAddress,
      matchingId: esim.matchingId,
    }

    // Already installable → nothing to repair
    if (hasUsableInstallData(current)) {
      if (esim.installationStatus !== 'READY') {
        if (apply) await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'READY', installationLastCheckedAt: new Date() } })
        repaired++
        console.log(`  ${mask(esim.iccid)} → marked READY (data already present)`)
      } else {
        alreadyReady++
      }
      continue
    }

    // 1. Whitelist extraction from providerResponse
    let merged = mergeInstallData(current, extractInstallDataFromProviderResponse(esim.providerResponse))

    // 2. Read-only provider QR fetch when supported
    const providerId = esim.purchase?.package?.providerId
    if (!hasUsableInstallData(merged) && providerId && esim.iccid) {
      const provider = await prisma.provider.findUnique({ where: { id: providerId } })
      if (provider?.supportsQRCode) {
        try {
          const adapter = await getAdapterForType(provider.type, {
            apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
            providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
          })
          if (adapter?.getQRCode) {
            const qrResult = await adapter.getQRCode(esim.iccid)
            if (qrResult.success && qrResult.data) {
              merged = mergeInstallData(merged, normalizeConnectorInstallData(qrResult.data))
            }
          }
        } catch (e: any) {
          console.log(`  ${mask(esim.iccid)} provider QR fetch error: ${e?.message?.substring(0, 120)}`)
        }
      } else if (provider && !provider.supportsQRCode) {
        notSupported++
      }
    }

    const combined: InstallDataFields = {
      activationCode: current.activationCode || merged.activationCode,
      qrCodeUrl: current.qrCodeUrl || merged.qrCodeUrl,
      qrCode: current.qrCode || merged.qrCode,
      smdpAddress: current.smdpAddress || merged.smdpAddress,
      matchingId: current.matchingId || merged.matchingId,
    }

    if (hasUsableInstallData(combined)) {
      const fill: any = {}
      if (merged.activationCode && !current.activationCode) fill.activationCode = merged.activationCode
      if (merged.qrCodeUrl && !current.qrCodeUrl) fill.qrCodeUrl = merged.qrCodeUrl
      if (merged.qrCode && !current.qrCode) fill.qrCode = merged.qrCode
      if (merged.smdpAddress && !current.smdpAddress) fill.smdpAddress = merged.smdpAddress
      if (merged.matchingId && !current.matchingId) fill.matchingId = merged.matchingId
      fill.installationStatus = 'READY'
      fill.installationLastCheckedAt = new Date()

      const filledFields = Object.keys(fill).filter(k => k !== 'installationStatus' && k !== 'installationLastCheckedAt')
      console.log(`  ${mask(esim.iccid)} → READY (fills: ${filledFields.join(', ') || 'none'})`)
      if (apply) {
        await prisma.eSIM.update({ where: { id: esim.id }, data: fill })
      }
      repaired++
    } else {
      stillPending++
    }
  }

  console.log('')
  console.log(`  Scanned: ${scanned}`)
  console.log(`  Already READY: ${alreadyReady}`)
  console.log(`  Repaired: ${repaired}${dryRun ? ' (dry run — not written)' : ''}`)
  console.log(`  Still pending (no install data found): ${stillPending}`)
  console.log(`  Provider QR not supported: ${notSupported}`)
  console.log(`  Failed: ${failed}`)

  prisma.$disconnect()
}

function mask(iccid: string): string {
  const s = String(iccid || '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

main().catch(err => { console.error(err); process.exit(1) })
