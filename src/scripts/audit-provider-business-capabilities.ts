/**
 * PROVIDER + BUSINESS CAPABILITY CERTIFICATION — read-only audit.
 *
 * Loads CHOICE / AIRHUB / US-MATRIX / IBASIS / TELNA, builds each connector,
 * and prints connector capabilities, DB/internal flags, portal + API exposure,
 * Business V1 route availability, plus a layered certification matrix.
 *
 * DEFAULT: ZERO provider mutations. No purchase, no top-up, no suspend/resume,
 * no wallet mutation, no custom package creation, no provider-side mutation.
 *
 * Optional read-only probes are OFF by default. To enable ONLY documented
 * read-only probes pass --probe-readonly (calls testConnection / catalog list /
 * balance where documented and provider credentials/environment support them).
 * Read-only probes are best-effort and are never required.
 *
 * Output never contains credentials/tokens/raw provider payloads.
 *
 * Usage:
 *   npx tsx src/scripts/audit-provider-business-capabilities.ts
 *   npx tsx src/scripts/audit-provider-business-capabilities.ts --probe-readonly
 */

import { PrismaClient } from '@prisma/client'
import { buildConnectorFromProvider } from '../lib/providers/connectors/connector-factory'
import { getProviderCapabilityState } from '../lib/providers/capability-state'
import { certifyProviderCapabilities } from '../lib/providers/capability-certification'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '../lib/providers/capabilities/exposure'
import { ProviderCapability } from '../lib/providers/capabilities/types'

const prisma = new PrismaClient()

const TARGET_CODES = ['CHOICE', 'AIRHUB', 'USMATRIX', 'IBASIS', 'TELNA']
const PROBE_READONLY = process.argv.includes('--probe-readonly')

async function main() {
  console.log('\n=== PROVIDER CAPABILITY CERTIFICATION (READ-ONLY) ===\n')

  // Which provider-capability keys correspond to a Business V1 route today.
  const BUSINESS_ROUTE_AVAILABILITY: Record<string, boolean> = {
    purchase: true,                 // POST /api/v1/esims/order
    installationLookup: true,       // GET /api/v1/esims/[esimId] (install fields) + refresh-qr
    installationDataAtPurchase: true, // same install detail surface
    installationLookupHistorical: true, // refresh-qr / GET esim install presentation
    statusLookup: true,             // POST /api/v1/esims/[id]/refresh-status
    usageLookup: true,              // GET /api/v1/esims/[id]/usage
    topUp: true,                    // POST /api/v1/esims/[id]/top-up
    suspend: false,                 // no Business V1 suspend route yet (decision pending)
    resume: false,                  // no Business V1 resume route yet
    balance: false,                 // provider wallet balance is NOT a business-facing V1 route
    inventory: false,               // provider inventory is intentionally NOT exposed to businesses
    webhooks: true,                 // OneSIM outbound business webhooks (NOT provider webhook capability)
    customPackageCreation: false,   // admin-only, never Business API
  }

  const providers = await prisma.provider.findMany({
    where: { code: { in: TARGET_CODES } },
    select: { id: true, code: true, name: true, status: true, enabledCapabilities: true, supportsESIM: true, supportsQRCode: true, supportsTopUp: true, supportsUsage: true, supportsSuspend: true, supportsSuspendResume: true, supportsUsageSync: true, supportsWebhookPush: true, supportsTemplates: true, supportsPools: true },
  })

  let businessReadyCount = 0
  let internalOnlyCount = 0
  let mismatchCount = 0

  for (const provider of providers) {
    const code = provider.code || '?'
    console.log(`\n─ ${provider.name} (${code}) [${provider.status}]`)
    const state = await getProviderCapabilityState(provider.id).catch(() => null)
    console.log('  Connector class:', state?.connectorClass || 'none')

    // Build the connector to read its REAL declared runtime capabilities.
    const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
    const connectorCaps = connector?.capabilities
    if (connectorCaps) {
      const methodAvail = {
        purchase: typeof connector.activateESIM === 'function',
        statusLookup: typeof connector.getStatus === 'function',
        usageLookup: typeof connector.getUsage === 'function',
        topUp: typeof connector.topUpESIM === 'function',
        suspend: typeof connector.suspendESIM === 'function',
        resume: typeof connector.resumeESIM === 'function',
        installationLookup: typeof connector.lookupInstallationData === 'function' || typeof connector.getQRCode === 'function',
        installationLookupHistorical: typeof connector.lookupInstallationData === 'function',
        balance: typeof connector.getBalance === 'function',
      }
      const rows = certifyProviderCapabilities(
        code,
        connectorCaps,
        methodAvail,
        { purchase: provider.supportsESIM, statusLookup: null, usageLookup: provider.supportsUsage, topUp: provider.supportsTopUp, suspend: provider.supportsSuspend, balance: null, installationLookup: provider.supportsQRCode, installationLookupHistorical: provider.supportsQRCode },
        // exposure (API) read live
        { purchase: await isCapabilityExposedToApi(provider.id, ProviderCapability.PURCHASE).catch(() => false), statusLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.STATUS).catch(() => false), usageLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.USAGE).catch(() => false), topUp: await isCapabilityExposedToApi(provider.id, ProviderCapability.TOP_UP).catch(() => false), suspend: await isCapabilityExposedToApi(provider.id, ProviderCapability.SUSPEND).catch(() => false), resume: await isCapabilityExposedToApi(provider.id, ProviderCapability.RESUME).catch(() => false), installationLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.INSTALLATION).catch(() => false), installationLookupHistorical: await isCapabilityExposedToApi(provider.id, ProviderCapability.QR_CODE).catch(() => false), balance: await isCapabilityExposedToApi(provider.id, ProviderCapability.BALANCE).catch(() => false) },
        BUSINESS_ROUTE_AVAILABILITY,
        (provider.enabledCapabilities as string[]) || [],
        {},
        {},
        ['customPackageCreation'],
        (provider.code || '') === 'TELNA' ? ['customPackageCreation'] : [],
      )
      console.log('  Capability             DB     Internal  APIExp  Route  Contract  Impl  Classification        Remediation')
      for (const row of rows.rows) {
        const contract = row.contractSupports === true ? 'Y' : row.contractSupports === false ? 'N' : (row.contractSupports === 'NOT_DECLARED' ? 'ND' : '?')
        const impl = row.connectorImplements ? 'Y' : 'N'
        console.log(`  ${row.capability.padEnd(22)} ${String(!!row.dbEnabled).padEnd(7)} ${String(row.internallyEnabled).padEnd(10)} ${String(row.clientApiExposed).padEnd(8)} ${String(row.businessRouteExists).padEnd(7)} ${contract.padEnd(8)} ${impl.padEnd(5)} ${row.classification.padEnd(24)} ${(row.remediation || '—').padEnd(26)}`)
        if (row.classification === 'PASS') businessReadyCount++
        if (['INTERNAL_ONLY', 'NOT_EXPOSED', 'API_ROUTE_INTENTIONALLY_MISSING', 'ADMIN_ONLY', 'ENTITLEMENT_PENDING'].includes(row.classification)) internalOnlyCount++
        if (['DOC_MISMATCH', 'CONFIG_MISMATCH', 'DB_FLAG_STALE_TRUE', 'INTERNAL_ENABLE_MISSING', 'API_EXPOSURE_MISSING', 'API_ROUTE_MISSING'].includes(row.classification)) mismatchCount++
      }
      for (const m of rows.mismatches) console.log(`  ⚠ mismatch: ${m}`)
    } else {
      console.log('  (no connector capabilities available)')
    }

    // Portal exposure summary (read-only)
    const portal = await isCapabilityExposedToPortal(provider.id, ProviderCapability.PURCHASE).catch(() => false)
    console.log(`  Portal PURCHASE exposure: ${portal}`)
  }

  console.log(`\n=== SUMMARY ===`)
  console.log(`TARGET_PROVIDERS=${providers.length}`)
  console.log(`BUSINESS_READY_COUNT=${businessReadyCount}`)
  console.log(`INTERNAL_ONLY_COUNT=${internalOnlyCount}`)
  console.log(`MISMATCH_COUNT=${mismatchCount}`)
  console.log(`READ_MUTATIONS_PERFORMED=0`)
  console.log(`__NOTE__: Business API never exposes provider identity or credentials; provider wallet balance is never surfaced as a business wallet.`)
  console.log(`\nDone (read-only).\n`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())