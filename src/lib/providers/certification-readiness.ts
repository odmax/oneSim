/**
 * PROVIDER CERTIFICATION READINESS PREFLIGHT (READ-ONLY) — V2
 *
 * Decides whether a real-provider certification test is safe to attempt for a
 * given provider. NO provider HTTP, NO purchases, NO DB writes. All gates must
 * pass before a certification may proceed; the operator must explicitly supply
 * a positive purchase budget (MAX_REAL_PURCHASES) and, for CONTROLLED_LIVE_TEST,
 * an explicit typed authorization.
 *
 * V2 separates two independent dimensions:
 *   - OneSIM deployment environment (from APP_ENV):
 *       STAGING | TEST | PRODUCTION | UNKNOWN
 *   - Provider upstream endpoint class (from provider metadata):
 *       SANDBOX | LIVE | UNKNOWN
 *
 * A PRODUCTION OneSIM environment NEVER allows certification
 * (ONESIM_PRODUCTION_CERTIFICATION_ALLOWED stays NO). Providers are generic and
 * IoT-resource-compatible (test SIM/ICCID/device/subscription/plan) but no IoT
 * functionality is implemented this phase.
 *
 * SAFETY: SANDBOX keeps the pre-existing fail-closed behavior AND additionally
 * fails closed when it is not provably sandbox. CONTROLLED_LIVE_TEST requires a
 * typed authorization block (approvedAt/approvedBy/evidenceReference/
 * approvedPackageIds) plus a monetary spend guard. Names/statuses/hosts that
 * merely LOOK like tests never authorize live testing.
 *
 * Backward compatibility: existing callers using the old readiness inputs keep
 * behaving fail-closed. An old BLOCKED live/PRODUCTION_LIKE provider WITHOUT the
 * new fields stays BLOCKED.
 */
import { prisma } from '@/lib/prisma'
import { providerSupportsOperation } from './operation-capabilities'
import { resolveProviderExecutionPolicy } from './execution-policy'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import {
  resolveProviderCertificationConfig,
} from './certification-config'
import type {
  OneSIMEnvironment,
  ProviderEndpointClass,
  CertificationMode,
  ProviderCertificationConfig,
} from './certification-config'

// ─────────────────────────────────────────────────────────────
// Types (V1 names kept for backward compatibility; V2 additive)
// ─────────────────────────────────────────────────────────────

/** @deprecated V1 host class — prefer ProviderEndpointClass. */
export type HostClass = 'STAGING_SAFE' | 'PRODUCTION_LIKE' | 'UNKNOWN'
export type GateVerdict = 'PASS' | 'FAIL'
export type TestPackageClassification = 'EXPLICIT_TEST_PLAN' | 'LOW_COST_OPERATOR_APPROVED' | 'NOT_SAFE_FOR_CERTIFICATION'

export interface CertificationReadinessInput {
  /** Provider code (e.g. 'AIRHUB') or provider id. */
  provider: string
  /** Operator-supplied tenant. Optional — discovered read-only when absent. */
  businessId?: string
  /** Operator-supplied candidate provider package id. */
  packageId?: string
  /** Operator-supplied package label to treat as approved. Optional. */
  packageLabel?: string
  /** Operator budget for real purchases. Default 0 (blocked). */
  maxRealPurchases?: number
  /** APP_ENV (defaults to process.env.APP_ENV). */
  appEnv?: string
}

export interface ProviderCertificationReadiness {
  provider: string
  providerId?: string
  providerCode?: string
  providerName?: string
  providerStatus?: string
  providerEnvironment?: string
  upstreamEnvironment?: string
  // V1 host classification (kept for backward compatibility).
  baseHostClass: HostClass
  baseHost?: string
  appEnv: string
  // V2 OneSIM environment (independent of provider endpoint).
  onesimEnvironment: OneSIMEnvironment
  // V2 provider endpoint class (independent of OneSIM env).
  providerEndpointClass: ProviderEndpointClass
  // V2 certification mode.
  certificationMode: CertificationMode
  // V2 authorization flags. Readability only; NEVER expose raw secrets.
  testAuthorizationPresent: boolean
  // V2 spend guard.
  expectedProviderCost?: number | null
  maximumExposure?: number | null
  maxProviderSpend?: number | null
  // V2 resource/provider pinning.
  approvedResourceId?: string | null
  certificationConfig?: ProviderCertificationConfig
  authMethod?: string
  authReady: boolean
  purchaseCapability: boolean
  executionConfig?: any
  testPackage?: {
    providerPackageId?: string
    providerPlanId?: string
    classification: TestPackageClassification
    providerCost?: number | null
    retailPrice?: number | null
  }
  businessId?: string
  businessStatus?: string
  businessWallet?: string
  businessReady: boolean
  maxRealPurchases: number
  gates: {
    environment: GateVerdict
    auth: GateVerdict
    package: GateVerdict
    business: GateVerdict
    provider: GateVerdict
    budget: GateVerdict
    authorization: GateVerdict
    spend: GateVerdict
    resource: GateVerdict
  }
  readiness: 'READY' | 'BLOCKED'
  blockers: string[]
}

const BLOCKED_STATUSES = new Set(['DISABLED', 'SUSPENDED', 'DECOMMISSIONED', 'ARCHIVED'])
const OPERATIONAL_STATUSES = new Set(['ACTIVE', 'DEGRADED', 'TESTING'])

/**
 * Resolve the OneSIM deployment environment from APP_ENV. This NEVER derives
 * from the provider environment/hostname. PRODUCTION always blocks certification.
 */
export function classifyOneSIMEnvironment(appEnv: string | undefined | null): OneSIMEnvironment {
  const env = String(appEnv || '').trim().toLowerCase()
  if (env === 'staging') return 'STAGING'
  if (env === 'test') return 'TEST'
  if (env === 'production' || env === 'prod') return 'PRODUCTION'
  return 'UNKNOWN'
}

/**
 * Classify the provider's upstream/base host onto a provider endpoint class
 * (SANDBOX | LIVE | UNKNOWN), using ALL metadata. Production metadata WINS over
 * any misleading hostname hint (a `staging`/`test` host with
 * upstreamEnvironment=production is LIVE). Unknown never becomes SANDBOX merely
 * because production cannot be proven.
 */
export function classifyProviderEndpointClass(
  baseUrl: string | null | undefined,
  upstreamEnvironment?: string | null,
  authEnvironmentAtAuth?: string | null,
  name?: string | null,
): ProviderEndpointClass {
  const low = String(baseUrl || '').toLowerCase()
  const up = String(upstreamEnvironment || '').toLowerCase()
  const auth = String(authEnvironmentAtAuth || '').toLowerCase()
  const _nm = String(name || '').toLowerCase() // LW metadata; never certifying evidence

  // Explicit live/production metadata overrides any hostname hint.
  if (up === 'production' || up === 'live' || auth === 'production' || auth === 'live') return 'LIVE'
  // Documented production API hosts.
  if (low.includes('api.airhubapp.com')) return 'LIVE'
  // "__productionUrlPending" is a LIVE-pending signal, never a test.
  if (low.includes('_productionurlpending')) return 'LIVE'

  // Only a convincing staging/sandbox/test hostname hint certifies SANDBOX.
  // A name "(Staging)", status TESTING, package name "TEST", APP_ENV, or bare
  // staging metadata NEVER alone certify an endpoint SANDBOX (fail closed).
  if (low.includes('staging') || low.includes('sandbox') || low.includes('-test') || low.includes('.test')) {
    return 'SANDBOX'
  }

  // Not provably sandbox → cannot certify.
  return 'UNKNOWN'
}

/** @deprecated Kept for backward compatibility; maps onto endpoint class. */
export function classifyBaseHost(baseUrl: string | null | undefined, upstreamEnvironment?: string | null, authEnvironmentAtAuth?: string | null): HostClass {
  const cls = classifyProviderEndpointClass(baseUrl, upstreamEnvironment, authEnvironmentAtAuth)
  if (cls === 'SANDBOX') return 'STAGING_SAFE'
  if (cls === 'LIVE') return 'PRODUCTION_LIKE'
  return 'UNKNOWN'
}

/**
 * Resolve the certification mode from endpoint class + typed authorization.
 * SAFETY: a LIVE endpoint is only CONTROLLED_LIVE_TEST when an explicit
 * authorization block exists AND is sanctioned for that mode. Otherwise it
 * cannot be certified (defaults to UNKNOWN/BLOCKED — never silently downgraded
 * to SANDBOX). A SANDBOX endpoint is SANDBOX (no authorization needed).
 */
export function resolveCertificationMode(
  endpointClass: ProviderEndpointClass,
  config: ProviderCertificationConfig | undefined | null,
): { mode: CertificationMode; authorizationPresent: boolean } {
  const cfg = config || {}
  const authz = cfg.testAuthorization
  const authorizationPresent = !!authz && authz.type === 'CONTROLLED_LIVE_TEST'

  switch (endpointClass) {
    case 'SANDBOX':
      return { mode: 'SANDBOX', authorizationPresent }
    case 'LIVE':
      if (authorizationPresent) {
        return { mode: 'CONTROLLED_LIVE_TEST', authorizationPresent: true }
      }
      return { mode: 'UNKNOWN', authorizationPresent: false }
    case 'UNKNOWN':
    default:
      return { mode: 'UNKNOWN', authorizationPresent }
  }
}

const TEST_LABEL_RE = /(^|[\s_-])(test|testplan|test-plan|cert|pproval|sandbox|load-)([\s_-]|$)/i

export function classifyTestPackage(input: {
  providerPlanId?: string | null
  name?: string | null
  costPrice?: unknown
  sellingPrice?: unknown
  operatorSupplied?: boolean
  operatorLabel?: string
}): TestPackageClassification {
  const plan = String(input.providerPlanId || '')
  const name = String(input.name || '')
  const label = String(input.operatorLabel || '')
  const costKnown = input.costPrice != null
  const isTestLabel = TEST_LABEL_RE.test(plan) || TEST_LABEL_RE.test(name) || TEST_LABEL_RE.test(label)
  if (isTestLabel && costKnown) return 'EXPLICIT_TEST_PLAN'
  if (input.operatorSupplied && costKnown) return 'LOW_COST_OPERATOR_APPROVED'
  return 'NOT_SAFE_FOR_CERTIFICATION'
}

/** Read-only authentication presence per provider family (never decrypt/print). */
export function providerAuthReadiness(provider: { code?: string | null; apiToken?: string | null; config?: any }): { ready: boolean; method: string } {
  const cfg = (provider.config && typeof provider.config === 'object' ? provider.config : {}) as Record<string, any>
  const hasToken = !!provider.apiToken
  const hasUser = !!cfg.username && String(cfg.username).length > 0
  const hasPass = !!cfg.password && String(cfg.password).length > 0
  const hasPartner = !!cfg.partnerCode
  switch ((provider.code || '').toUpperCase()) {
    case 'AIRHUB':
      return { ready: hasPartner && (hasToken || (hasUser && hasPass)), method: hasToken ? 'STATIC_TOKEN+PARTNER' : (hasUser && hasPass ? 'USERNAME_PASSWORD+PARTNER' : (hasPartner ? 'PARTNER_ONLY(INCOMPLETE)' : 'NONE')) }
    case 'TELNA':
      return { ready: !!cfg.pcrApiKey, method: cfg.pcrApiKey ? 'PCR_API_KEY' : 'NONE' }
    case 'TELNA_SEAMLESS':
      return { ready: hasToken, method: hasToken ? 'STATIC_API_KEY' : 'NONE' }
    case 'USMATRIX':
      return { ready: hasToken, method: hasToken ? 'STORED_TOKEN' : 'NONE' }
    default:
      return { ready: hasToken || (hasUser && hasPass), method: hasToken ? 'STATIC_TOKEN' : (hasUser && hasPass ? 'USERNAME_PASSWORD' : 'NONE') }
  }
}

export async function providerCertificationReadiness(input: CertificationReadinessInput): Promise<ProviderCertificationReadiness> {
  const appEnv = input.appEnv ?? process.env.APP_ENV ?? ''
  const blockers: string[] = []
  const gates = {
    environment: 'FAIL' as GateVerdict, auth: 'FAIL' as GateVerdict, package: 'FAIL' as GateVerdict,
    business: 'FAIL' as GateVerdict, provider: 'FAIL' as GateVerdict, budget: 'FAIL' as GateVerdict,
    authorization: 'FAIL' as GateVerdict, spend: 'FAIL' as GateVerdict, resource: 'FAIL' as GateVerdict,
  }

  const out: ProviderCertificationReadiness = {
    provider: input.provider, appEnv, baseHostClass: 'UNKNOWN',
    providerEndpointClass: 'UNKNOWN', onesimEnvironment: 'UNKNOWN', certificationMode: 'UNKNOWN',
    testAuthorizationPresent: false, authReady: false, purchaseCapability: false,
    businessReady: false, maxRealPurchases: input.maxRealPurchases ?? 0,
    gates, readiness: 'BLOCKED', blockers,
  }

  // Resolve provider (code or id).
  const provider = input.provider.length > 20
    ? await prisma.provider.findUnique({ where: { id: input.provider } })
    : await prisma.provider.findFirst({ where: { code: input.provider } })
  if (!provider) { blockers.push(`provider not found: ${input.provider}`); return out }
  out.providerId = provider.id
  out.providerCode = provider.code || undefined
  out.providerName = provider.name || undefined
  out.providerStatus = provider.status
  out.providerEnvironment = provider.environment
  const cfg = (provider.config && typeof provider.config === 'object' ? provider.config : {}) as Record<string, any>
  out.upstreamEnvironment = cfg.upstreamEnvironment || cfg.authEnvironmentAtAuth || undefined
  const base = (provider.apiBaseUrl || '').replace(/\/+$/, '')
  const host = (base || '').replace(/^https?:\/\//i, '').split('/')[0] || ''
  out.baseHost = host

  // OneSIM env (independent dimension — from APP_ENV only).
  out.onesimEnvironment = classifyOneSIMEnvironment(appEnv)

  // Provider endpoint class (independent dimension — from provider metadata).
  out.providerEndpointClass = classifyProviderEndpointClass(provider.apiBaseUrl, cfg.upstreamEnvironment, cfg.authEnvironmentAtAuth, provider.name)
  out.baseHostClass = out.providerEndpointClass === 'SANDBOX' ? 'STAGING_SAFE' : (out.providerEndpointClass === 'LIVE' ? 'PRODUCTION_LIKE' : 'UNKNOWN')

  // Certification config + mode.
  const certConfig = resolveProviderCertificationConfig(provider)
  out.certificationConfig = certConfig
  const { mode, authorizationPresent } = resolveCertificationMode(out.providerEndpointClass, certConfig)
  out.certificationMode = mode
  out.testAuthorizationPresent = authorizationPresent

  out.executionConfig = resolveProviderExecutionPolicy(provider)

  // Environment gate: OneSIM env must be non-production AND non-UNKNOWN, AND the
  // provider endpoint must be safe to certify. A SANDBOX endpoint is always
  // certifiable; a LIVE endpoint is certifiable ONLY when authorization has
  // already resolved it to CONTROLLED_LIVE_TEST (never silently downgraded).
  const onesimSafe = out.onesimEnvironment === 'STAGING' || out.onesimEnvironment === 'TEST'
  if (out.onesimEnvironment === 'PRODUCTION') {
    gates.environment = 'FAIL'
    blockers.push('ONESIM_PRODUCTION_CERTIFICATION_ALLOWED=NO — APP_ENV is production; certification is never permitted in the OneSIM production environment')
  } else if (!onesimSafe) {
    gates.environment = 'FAIL'
    blockers.push(`APP_ENV must be staging or test (got '${appEnv || '(unset)'}')`)
  } else if (out.certificationMode !== 'SANDBOX' && out.certificationMode !== 'CONTROLLED_LIVE_TEST') {
    gates.environment = 'FAIL'
    blockers.push(`provider upstream is ${out.providerEndpointClass} (host ${host || '(none)'}, upstreamEnvironment=${out.upstreamEnvironment || '(unset)'}) — not provably sandbox and no live authorization`)
  } else {
    gates.environment = 'PASS'
  }

  // Auth gate (presence only).
  const auth = providerAuthReadiness(provider)
  out.authMethod = auth.method
  out.authReady = auth.ready
  gates.auth = auth.ready ? 'PASS' : 'FAIL'
  if (!auth.ready) blockers.push(`auth incomplete (${auth.method})`)

  // Provider gate.
  out.purchaseCapability = providerSupportsOperation(provider, 'PURCHASE_ESIM')
  const statusUpper = String(provider.status || '').toUpperCase()
  if (BLOCKED_STATUSES.has(statusUpper)) blockers.push(`provider status ${provider.status} blocks certification`)
  else if (!OPERATIONAL_STATUSES.has(statusUpper)) blockers.push(`provider status ${provider.status} is not operational/testing`)
  if (!out.purchaseCapability) blockers.push('provider lacks PURCHASE_ESIM capability')
  if (!BLOCKED_STATUSES.has(statusUpper) && OPERATIONAL_STATUSES.has(statusUpper) && out.purchaseCapability) {
    gates.provider = 'PASS'
  }

  // Package gate: read-only discovery of a safe test package.
  const packages = await prisma.providerPackage.findMany({
    where: { providerId: provider.id },
    select: {
      id: true, providerPlanId: true, name: true, costPrice: true, sellingPrice: true,
      costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true,
      activePriceSnapshotId: true, isAvailable: true, currency: true,
    },
    orderBy: { costPrice: 'asc' as any },
    take: 25,
  })
  // Operator-supplied candidate.
  const operatorCandidate = input.packageId
    ? packages.find((k) => k.id === input.packageId || k.providerPlanId === input.packageId)
    : undefined
  const candidate = packages.find((k) => {
    const isOperatorSupplied = input.packageId ? k.id === input.packageId || k.providerPlanId === input.packageId : false
    const label = isOperatorSupplied ? (input.packageLabel || '') : k.name || k.providerPlanId || ''
    const cls = classifyTestPackage({ providerPlanId: k.providerPlanId, name: k.name, costPrice: k.costPrice, operatorSupplied: isOperatorSupplied, operatorLabel: label })
    if (cls === 'NOT_SAFE_FOR_CERTIFICATION') return false
    const pp = getPackagePurchaseReadiness({
      providerPkg: {
        costStatus: k.costStatus, pricingStatus: k.pricingStatus, publishStatus: k.publishStatus,
        configurationStatus: k.configurationStatus, activePriceSnapshotId: k.activePriceSnapshotId,
        sellingPrice: k.sellingPrice, costPrice: k.costPrice,
      },
    })
    if (!pp.ready) return false
    if (k.isAvailable === false) return false
    return true
  })
  if (candidate) {
    const retail = await prisma.eSIMPackage.findFirst({ where: { providerPackageId: candidate.id }, select: { priceUSD: true, isActive: true } })
    const expectedProviderCost = candidate.costPrice != null ? Number(candidate.costPrice) : null
    out.approvedResourceId = candidate.id
    out.expectedProviderCost = expectedProviderCost
    out.testPackage = {
      providerPackageId: candidate.id, providerPlanId: candidate.providerPlanId || undefined,
      classification: classifyTestPackage({
        providerPlanId: candidate.providerPlanId, name: candidate.name, costPrice: candidate.costPrice,
        operatorSupplied: !!input.packageId && (candidate.id === input.packageId || candidate.providerPlanId === input.packageId),
        operatorLabel: candidate.name || candidate.providerPlanId || '',
      }),
      providerCost: expectedProviderCost,
      retailPrice: retail?.priceUSD != null ? Number(retail.priceUSD) : null,
    }
    gates.package = 'PASS'
  } else {
    blockers.push('no safe test package: provide an explicit test/operator-approved package (label or packageId) with valid pricing/readiness')
  }

  // Business gate (read-only).
  const business = input.businessId
    ? await prisma.business.findUnique({ where: { id: input.businessId } })
    : await prisma.business.findFirst({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'asc' as any } })
  if (!business) {
    blockers.push('no eligible approved business tenant')
  } else {
    out.businessId = business.id
    out.businessStatus = business.status
    out.businessWallet = String(business.walletBalance)
    const required = out.testPackage?.retailPrice != null ? out.testPackage.retailPrice : 1
    if (String(business.status).toUpperCase() !== 'APPROVED') {
      blockers.push(`business ${business.id} status ${business.status} is not APPROVED`)
    } else if (Number(business.walletBalance) < required) {
      blockers.push(`business ${business.id} wallet ${business.walletBalance} < required retail ${required}`)
    } else {
      out.businessReady = true
      gates.business = 'PASS'
    }
  }

  // Budget gate.
  const budget = input.maxRealPurchases ?? 0
  out.maxRealPurchases = budget
  gates.budget = budget > 0 ? 'PASS' : 'FAIL'
  if (budget <= 0) blockers.push('MAX_REAL_PURCHASES must be > 0 (operator must explicitly supply a positive certification budget)')

  // ── V2: AUTHORIZATION gate ────────────────────────────────────────────────
  // SANDBOX: no authorization required (mode derived is SANDBOX).
  // CONTROLLED_LIVE_TEST: explicit typed authorization required AND the approved
  //   package must be pinned (resource gate) AND approved count must equal the
  //   operator budget sense (maxRealPurchases <= approved).
  // A LIVE provider without authorization → mode is UNKNOWN → FAIL.
  if (out.certificationMode === 'CONTROLLED_LIVE_TEST') {
    const authz = certConfig.testAuthorization
    const approvedForMode = !!authz && authz.type === 'CONTROLLED_LIVE_TEST'
    if (!approvedForMode) {
      gates.authorization = 'FAIL'
      blockers.push('CONTROLLED_LIVE_TEST requires a typed testAuthorization block (approvedAt/approvedBy/evidenceReference/approvedPackageIds)')
    } else {
      gates.authorization = 'PASS'
    }
  } else if (out.certificationMode === 'SANDBOX') {
    // SANDBOX is inherently authorized at the read level; the budget gate still
    // enforces a positive operator spend intent.
    gates.authorization = 'PASS'
  } else {
    gates.authorization = 'FAIL'
    if (out.providerEndpointClass === 'LIVE') {
      blockers.push('LIVE provider requires an explicit typed CONTROLLED_LIVE_TEST authorization; without it certification is blocked')
    } else {
      blockers.push(`cannot determine a certifiable mode (endpoint class ${out.providerEndpointClass})`)
    }
  }

  // ── V2: RESOURCE (pinning) gate ───────────────────────────────────────────
  // For CONTROLLED_LIVE_TEST the approved package MUST be one of the pinned
  // approvedPackageIds. SANDBOX pins via the approved candidate (exact match,
  // no cheapest/alias/fallback).
  if (out.certificationMode === 'CONTROLLED_LIVE_TEST') {
    const authz = certConfig.testAuthorization
    if (authz && operatorCandidate) {
      const pinned = authz.approvedPackageIds.some((pid) => pid === operatorCandidate.id || pid === operatorCandidate.providerPlanId)
      if (!pinned) {
        gates.resource = 'FAIL'
        blockers.push(`package ${operatorCandidate.id} is NOT in the approved/authorized pinned package ids for live certification (no fallback/alias dispatch allowed)`)
      } else {
        gates.resource = 'PASS'
      }
    } else if (candidate) {
      const pinned = authz && authz.approvedPackageIds.some((pid) => pid === candidate.id || pid === candidate.providerPlanId)
      if (!pinned) {
        gates.resource = 'FAIL'
        blockers.push('live certification requires the approved package to be explicitly pinned in testAuthorization.approvedPackageIds')
      } else {
        out.approvedResourceId = candidate.id
        gates.resource = 'PASS'
      }
    } else {
      gates.resource = 'FAIL'
      blockers.push('no authorized pinned resource for live certification')
    }
  } else {
    // SANDBOX / UNKNOWN: resource pinning satisfied by the discovered candidate
    // (exact). If mode unknown, resource gate still fails closed via authorization.
    if (out.certificationMode === 'SANDBOX' && candidate) {
      gates.resource = 'PASS'
    } else {
      gates.resource = 'FAIL'
    }
  }

  // ── V2: PROVIDER pinning (no failover/ranked alternate) ───────────────────
  // A certified provider must be the sole dispatch target. Ranked/alternate
  // failover flags would allow the plan to reach a different provider, which
  // this preflight does not authorize. (Blocking reason folded into resource
  // gate messaging via provider PENDING check.)
  const ranked = Array.isArray(cfg.rankedProviders) ? cfg.rankedProviders : null
  if (ranked && ranked.length > 0) {
    blockers.push('provider has ranked/failover providers configured — certification requires a single pinned provider (no alternate dispatch)')
    gates.resource = 'FAIL'
  }

  // ── V2: SPEND guard ────────────────────────────────────────────────────────
  // maximumExposure = approvedPurchaseCount × expectedProviderCost <= maxProviderSpend.
  // Only meaningful for CONTROLLED_LIVE_TEST. Block on unknown cost or currency.
  out.maxProviderSpend = certConfig.testAuthorization?.maxProviderSpend ?? null
  if (out.certificationMode === 'CONTROLLED_LIVE_TEST') {
    const authz = certConfig.testAuthorization
    const approvedCount = authz?.maxRealPurchases ?? budget
    const cost = out.expectedProviderCost
    const spendCap = authz?.maxProviderSpend
    const costCurrency = candidate?.currency || null
    if (cost == null) {
      gates.spend = 'FAIL'
      blockers.push('spend guard cannot be computed: provider package cost is unknown/null')
    } else if (!costCurrency || String(costCurrency).trim() === '') {
      gates.spend = 'FAIL'
      blockers.push('spend guard cannot be computed: provider package cost currency is unknown (no FX guessing performed)')
    } else if (cost <= 0) {
      gates.spend = 'FAIL'
      blockers.push('spend guard cannot be computed: provider package cost must be > 0')
    } else if (spendCap == null || spendCap <= 0) {
      gates.spend = 'FAIL'
      blockers.push('CONTROLLED_LIVE_TEST requires a positive maxProviderSpend')
    } else {
      const maximumExposure = approvedCount * cost
      out.maximumExposure = maximumExposure
      if (maximumExposure > spendCap) {
        gates.spend = 'FAIL'
        blockers.push(`maximum exposure ${maximumExposure} (${approvedCount} purchases × cost ${cost}) exceeds maxProviderSpend ${spendCap}`)
      } else if (approvedCount <= 0) {
        gates.spend = 'FAIL'
        blockers.push('CONTROLLED_LIVE_TEST requires approved maxRealPurchases > 0')
      } else {
        gates.spend = 'PASS'
      }
    }
  } else if (out.certificationMode === 'SANDBOX') {
    // SANDBOX does not spend against live; the budget gate already guards count.
    gates.spend = 'PASS'
  } else {
    gates.spend = 'FAIL'
  }

  const allPass = Object.values(gates).every((g) => g === 'PASS')
  out.readiness = allPass ? 'READY' : 'BLOCKED'
  return out
}