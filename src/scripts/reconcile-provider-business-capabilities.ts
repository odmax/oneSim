/**
 * PROVIDER BUSINESS-CAPABILITY RECONCILIATION PLAN — READ-ONLY BY DEFAULT.
 *
 * Classifies every capability of the five target providers against the layered
 * certification semantics and prints DETERMINISTIC proposed corrections.
 *
 * DEFAULT: DRY-RUN — ZERO DB writes, ZERO exposure writes, ZERO provider writes.
 *
 * `--apply` applies ONLY deterministic DB/internal-enable and capability-
 * exposure corrections. It NEVER:
 *   - writes connector credentials / endpoints / provider config
 *   - performs any provider mutation (no purchase/topup/suspend/custom create)
 *   - applies UNKNOWN / ENTITLEMENT_PENDING corrections
 *   - exposes admin-only capabilities to businesses
 *   - auto-resolves CONNECTOR_RESOLUTION_WRONG (e.g. AirHub → dedicated
 *     AirHubConnector) which requires manual provider config change
 *
 *   This task does NOT run --apply against any environment.
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-provider-business-capabilities.ts        # dry-run
 *   npx tsx src/scripts/reconcile-provider-business-capabilities.ts --apply # gated writes
 */

import { PrismaClient } from '@prisma/client'
import { buildConnectorFromProvider } from '../lib/providers/connectors/connector-factory'
import { certifyProviderCapabilities, remediationCategory } from '../lib/providers/capability-certification'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '../lib/providers/capabilities/exposure'
import { ProviderCapability } from '../lib/providers/capabilities/types'

const prisma = new PrismaClient()

const TARGET_CODES = ['CHOICE', 'AIRHUB', 'USMATRIX', 'IBASIS', 'TELNA']
const APPLY = process.argv.includes('--apply')

/** Intended Business-API-ready capability per provider (manual intent source). */
const INTENDED_BUSINESS_READY: Record<string, string[]> = {
  CHOICE: ['purchase', 'installationLookup', 'statusLookup', 'usageLookup', 'topUp'],
  AIRHUB: ['purchase', 'installationLookup', 'statusLookup'],
  USMATRIX: ['purchase', 'installationLookup', 'installationLookupHistorical', 'statusLookup', 'usageLookup'],
  IBASIS: ['purchase', 'installationLookup', 'statusLookup'],
  TELNA: ['purchase', 'installationLookup', 'installationLookupHistorical', 'statusLookup', 'usageLookup'],
}

/** Capabilities that must remain internal/admin-only (never Business-API exposed). */
const ALWAYS_INTERNAL: Record<string, string[]> = {
  CHOICE: ['balance', 'suspend', 'resume', 'inventory', 'webhooks', 'customPackageCreation'],
  AIRHUB: ['balance', 'suspend', 'resume', 'inventory', 'webhooks', 'customPackageCreation', 'topUp'],
  USMATRIX: ['balance', 'topUp', 'webhooks', 'customPackageCreation', 'suspend', 'resume', 'inventory'],
  IBASIS: ['balance', 'topUp', 'usageLookup', 'suspend', 'resume', 'inventory', 'webhooks', 'customPackageCreation'],
  TELNA: ['balance', 'topUp', 'suspend', 'resume', 'inventory', 'webhooks'],
}

/**
 * Capabilities that are ADMIN_ONLY — implemented + internally enabled but
 * intentionally never exposed to the Business API (custom package creation).
 * These classify as ADMIN_ONLY, NOT generic INTERNAL_ONLY, and never become
 * business-ready (no auto-enable / no exposure proposal).
 */
const ADMIN_ONLY_CAPS: Record<string, string[]> = {
  CHOICE: ['customPackageCreation'],
  AIRHUB: ['customPackageCreation'],
  USMATRIX: ['customPackageCreation'],
  IBASIS: ['customPackageCreation'],
  TELNA: ['customPackageCreation'],
}

/**
 * Capabilities that are ENTITLEMENT_PENDING — supported + implemented + admin-
 * only, but gated on account/entitlement certification before use (e.g. Telna
 * custom package creation). These specific states win over generic INTERNAL_ONLY
 * and are NEVER auto-applied.
 */
const ENTITLEMENT_PENDING_CAPS: Record<string, string[]> = {
  TELNA: ['customPackageCreation'],
}

const BUSINESS_ROUTE_AVAILABILITY: Record<string, boolean> = {
  purchase: true, installationLookup: true, installationDataAtPurchase: true, installationLookupHistorical: true,
  statusLookup: true, usageLookup: true, topUp: true,
  suspend: false, resume: false, balance: false, inventory: false, webhooks: true, customPackageCreation: false,
}

/** Explicit "documented upstream contract" truth (captured from repo evidence). */
const CONTRACT_DOCUMENTED: Record<string, Partial<Record<string, boolean>>> = {
  CHOICE: { balance: true, suspend: true, resume: true, topUp: true, customPackageCreation: true },
  AIRHUB: { topUp: true, customPackageCreation: false },
  USMATRIX: { suspend: true, resume: true },
  IBASIS: { webhooks: true },
  TELNA: { balance: true, inventory: true, customPackageCreation: true },
}

const CAP_CAPABILITY: Record<string, string> = {
  purchase: ProviderCapability.PURCHASE, installationLookup: ProviderCapability.INSTALLATION,
  installationDataAtPurchase: ProviderCapability.INSTALLATION, installationLookupHistorical: ProviderCapability.QR_CODE,
  statusLookup: ProviderCapability.STATUS, usageLookup: ProviderCapability.USAGE, topUp: ProviderCapability.TOP_UP,
  suspend: ProviderCapability.SUSPEND, resume: ProviderCapability.RESUME, balance: ProviderCapability.BALANCE,
  inventory: ProviderCapability.INVENTORY, webhooks: ProviderCapability.WEBHOOKS, customPackageCreation: ProviderCapability.CUSTOM_PACKAGE_CREATION,
}

async function main() {
  console.log(`\n=== PROVIDER BUSINESS-CAPABILITY RECONCILIATION ${APPLY ? '(APPLY MODE)' : '(DRY RUN)'} ===\n`)

  const providers = await prisma.provider.findMany({
    where: { code: { in: TARGET_CODES } },
    select: { id: true, code: true, name: true, type: true, status: true, adapterStrategy: true,
      enabledCapabilities: true, supportsESIM: true, supportsQRCode: true, supportsUsage: true, supportsUsageSync: true,
      supportsTopUp: true, supportsSuspend: true, supportsSuspendResume: true, supportsWebhookPush: true, supportsTemplates: true, supportsPools: true },
  })

  const proposals: Array<{ provider: string; capability: string; action: string; category: string; safe: boolean }> = []

  for (const provider of providers) {
    const code = provider.code || '?'
    const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
    const connectorCaps = connector?.capabilities
    const connectorClass = connector?.constructor.name || 'none'

    // print safe provider summary
    console.log(`─ ${provider.name} (${code}) [${provider.status}] strategy=${provider.adapterStrategy} type=${provider.type} connector=${connectorClass}`)

    if (!connectorCaps) {
      console.log('  (no connector capabilities — cannot certify)\n')
      continue
    }

    const methodAvail = {
      purchase: typeof connector.activateESIM === 'function', statusLookup: typeof connector.getStatus === 'function',
      usageLookup: typeof connector.getUsage === 'function', topUp: typeof connector.topUpESIM === 'function',
      suspend: typeof connector.suspendESIM === 'function', resume: typeof connector.resumeESIM === 'function',
      installationLookup: typeof (connector as any).lookupInstallationData === 'function' || typeof (connector as any).getQRCode === 'function',
      installationLookupHistorical: typeof (connector as any).lookupInstallationData === 'function',
      balance: typeof connector.getBalance === 'function',
    }

    const rows = certifyProviderCapabilities(
      code, connectorCaps, methodAvail,
      { purchase: provider.supportsESIM, statusLookup: null, usageLookup: provider.supportsUsage, topUp: provider.supportsTopUp, suspend: provider.supportsSuspend, balance: null, installationLookup: provider.supportsQRCode, installationLookupHistorical: provider.supportsQRCode },
      { purchase: await isCapabilityExposedToApi(provider.id, ProviderCapability.PURCHASE).catch(() => false), statusLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.STATUS).catch(() => false), usageLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.USAGE).catch(() => false), topUp: await isCapabilityExposedToApi(provider.id, ProviderCapability.TOP_UP).catch(() => false), suspend: await isCapabilityExposedToApi(provider.id, ProviderCapability.SUSPEND).catch(() => false), resume: await isCapabilityExposedToApi(provider.id, ProviderCapability.RESUME).catch(() => false), installationLookup: await isCapabilityExposedToApi(provider.id, ProviderCapability.INSTALLATION).catch(() => false), installationLookupHistorical: await isCapabilityExposedToApi(provider.id, ProviderCapability.QR_CODE).catch(() => false), balance: await isCapabilityExposedToApi(provider.id, ProviderCapability.BALANCE).catch(() => false) },
      BUSINESS_ROUTE_AVAILABILITY,
      (provider.enabledCapabilities as string[]) || [],
      {}, CONTRACT_DOCUMENTED[code] || {},
      ADMIN_ONLY_CAPS[code] || [],
      ENTITLEMENT_PENDING_CAPS[code] || [],
    )

    // AIRHUB: connector resolution is UNRESOLVED (REST_CATALOG vs dedicated
    // AirHubConnector under investigation). NO AirHub DB/exposure settings may be
    // auto-repaired until resolution is proven. Only the manual blocked report at
    // the end of this script speaks for AirHub.
    const airhubBlocked = code === 'AIRHUB'

    for (const row of rows.rows) {
      const cap = row.capability
      const remediation = remediationCategory(row.classification)
      const providerCap = CAP_CAPABILITY[cap]

      const intended = INTENDED_BUSINESS_READY[code]?.includes(cap) || false
      const alwaysInternal = ALWAYS_INTERNAL[code]?.includes(cap) || false
      const contractDocumented = CONTRACT_DOCUMENTED[code]?.[cap] === true

      // ── Build deterministic proposal (dry-run only) ──
      // Hard block: AirHub safe auto-repairs are suspended pending connector
      // resolution. Only allow this provider through the manual blocked report.
      if (airhubBlocked && row.classification !== 'ENTITLEMENT_PENDING') {
        continue
      }
      if (row.classification === 'DB_FLAG_STALE_TRUE') {
        proposals.push({ provider: code, capability: cap, action: `DISABLE stale ${cap} DB/registry flag`, category: 'DB_FLAG_STALE_TRUE', safe: true })
      } else if (row.classification === 'INTERNAL_ENABLE_MISSING' && intended && !alwaysInternal && providerCap) {
        proposals.push({ provider: code, capability: cap, action: `ENABLE internal ${providerCap} registry`, category: 'ENABLED_CAPABILITY_MISSING', safe: true })
      } else if (row.classification === 'API_EXPOSURE_MISSING' && intended && providerCap && !alwaysInternal) {
        proposals.push({ provider: code, capability: cap, action: `ENABLE API exposure ${providerCap}`, category: 'API_EXPOSURE_MISSING', safe: true })
      } else if (row.classification === 'CONTRACT_SUPPORTED_NOT_IMPLEMENTED') {
        proposals.push({ provider: code, capability: cap, action: `CONTRACT_NOT_IMPLEMENTED — implement ${cap} in connector (manual)`, category: 'CONTRACT_NOT_IMPLEMENTED', safe: false })
      } else if (row.classification === 'ENTITLEMENT_PENDING') {
        proposals.push({ provider: code, capability: cap, action: `ENTITLEMENT_PENDING — certify account before use (manual)`, category: 'ENTITLEMENT_PENDING', safe: false })
      } else if (row.classification === 'ADMIN_ONLY') {
        proposals.push({ provider: code, capability: cap, action: `ADMIN_ONLY — keep admin-gated, never business-exposed`, category: 'ADMIN_ONLY', safe: true })
      } else if (row.classification === 'NOT_EXPOSED' && intended && providerCap && !alwaysInternal) {
        proposals.push({ provider: code, capability: cap, action: `ENABLE API exposure ${providerCap}`, category: 'API_EXPOSURE_MISSING', safe: true })
      }
    }

    // Portal read-only note
    const portalPurchase = await isCapabilityExposedToPortal(provider.id, ProviderCapability.PURCHASE).catch(() => false)
    console.log(`  Portal PURCHASE exposure: ${portalPurchase}`)
    for (const p of proposals.filter(p => p.provider === code)) {
      console.log(`  PROPOSE ${p.category.padEnd(28)} ${p.action}${p.safe ? '' : ' [MANUAL]'}`)
    }
    console.log('')
  }

  // ── AIRHUB connector-resolution explicit report (cannot auto-fix) ──
  const airhub = providers.find(p => p.code === 'AIRHUB')
  if (airhub) {
    const conn = await buildConnectorFromProvider(airhub.id).catch(() => null)
    console.log(`AIRHUB CONNECTOR RESOLUTION: strategy=${airhub.adapterStrategy} → connector=${conn?.constructor.name || 'none'}`)
    if ((airhub.adapterStrategy || '').toUpperCase() !== 'AIRHUB') {
      console.log('  ⚠ CONNECTOR_RESOLUTION_WRONG — expected dedicated AirHubConnector.')
      console.log('  BLOCKED: connector config change is MANUAL (never auto-applied).')
      proposals.push({ provider: 'AIRHUB', capability: '*', action: 'MANUAL: set adapterStrategy=AIRHUB (connector config)', category: 'CONNECTOR_RESOLUTION_WRONG', safe: false })
    }
  }

  const safeProposals = proposals.filter(p => p.safe)
  const manualProposals = proposals.filter(p => !p.safe)

  console.log('\n=== SUMMARY ===')
  console.log(`TARGET_PROVIDERS=${providers.length}`)
  console.log(`PROPOSED_SAFE_CHANGES=${safeProposals.length}`)
  console.log(`MANUAL_REVIEW_CHANGES=${manualProposals.length}`)
  console.log(`BLOCKED_CONNECTOR_RESOLUTION=${proposals.filter(p => p.category === 'CONNECTOR_RESOLUTION_WRONG').length}`)
  console.log(`MODE=${APPLY ? 'APPLY' : 'DRY-RUN'}  WRITES_PERFORMED=0`)

  if (APPLY) {
    console.log('\n--apply would apply ONLY safe proposals. Use ONLY against an explicit, reviewed environment after a dry-run passes. (Not executed in this task.)')
  }
  console.log('\nDone.\n')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())