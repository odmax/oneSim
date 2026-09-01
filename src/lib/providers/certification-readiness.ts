/**
 * PROVIDER CERTIFICATION READINESS PREFLIGHT (READ-ONLY)
 *
 * Decides whether a real-provider purchase certification test is safe to
 * attempt for a given provider. NO provider HTTP, NO purchases, NO DB writes.
 * All gates must pass before a certification may proceed; the operator must
 * explicitly supply a positive purchase budget (MAX_REAL_PURCHASES).
 *
 * Built to prevent the AirHub failure mode: production-like upstream, missing
 * auth, no test package, no eligible test business.
 */
import { prisma } from '@/lib/prisma'
import { providerSupportsOperation } from './operation-capabilities'
import { resolveProviderExecutionPolicy } from './execution-policy'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export type HostClass = 'STAGING_SAFE' | 'PRODUCTION_LIKE' | 'UNKNOWN'
export type GateVerdict = 'PASS' | 'FAIL'
export type TestPackageClassification = 'EXPLICIT_TEST_PLAN' | 'LOW_COST_OPERATOR_APPROVED' | 'NOT_SAFE_FOR_CERTIFICATION'

export interface CertificationReadinessInput {
  /** Provider code (e.g. 'AIRHUB') or provider id. */
  provider: string
  /** Operator-supplied tenant. Optional — discovered read-only when absent. */
  businessId?: string
  /** Operator-supplied candidate provider package id. Optional. */
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
  baseHostClass: HostClass
  baseHost?: string
  appEnv: string
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
  }
  readiness: 'READY' | 'BLOCKED'
  blockers: string[]
}

const BLOCKED_STATUSES = new Set(['DISABLED', 'SUSPENDED', 'DECOMMISSIONED', 'ARCHIVED'])
const OPERATIONAL_STATUSES = new Set(['ACTIVE', 'DEGRADED', 'TESTING'])

/** Classify the provider's upstream/base host environment using ALL metadata.
 *  Production metadata WINS over any misleading hostname hint (a `staging`/`test`
 *  host with upstreamEnvironment=production is PRODUCTION_LIKE). Unknown never
 *  becomes STAGING_SAFE merely because production cannot be proven. */
export function classifyBaseHost(baseUrl: string | null | undefined, upstreamEnvironment?: string | null, authEnvironmentAtAuth?: string | null): HostClass {
  const low = String(baseUrl || '').toLowerCase()
  const up = String(upstreamEnvironment || '').toLowerCase()
  const auth = String(authEnvironmentAtAuth || '').toLowerCase()

  // Explicit production metadata overrides any hostname hint.
  if (up === 'production' || auth === 'production') return 'PRODUCTION_LIKE'
  // Documented production API hosts.
  if (low.includes('api.airhubapp.com')) return 'PRODUCTION_LIKE'
  // Only now may a convincing staging/sandbox/test hostname hint count.
  if (low.includes('staging') || low.includes('sandbox') || low.includes('-test') || low.includes('.test')) {
    return 'STAGING_SAFE'
  }
  // Not provably staging/test → cannot certify.
  return 'UNKNOWN'
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

export async function providerCertificationReadiness(input: CertificationReadinessInput): Promise<ProviderCertificationReadiness> {
  const appEnv = input.appEnv ?? process.env.APP_ENV ?? ''
  const blockers: string[] = []
  const gates = { environment: 'FAIL' as GateVerdict, auth: 'FAIL' as GateVerdict, package: 'FAIL' as GateVerdict, business: 'FAIL' as GateVerdict, provider: 'FAIL' as GateVerdict, budget: 'FAIL' as GateVerdict }

  const out: ProviderCertificationReadiness = {
    provider: input.provider, appEnv, baseHostClass: 'UNKNOWN', authReady: false, purchaseCapability: false,
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
  const host = (base || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0] || ''
  out.baseHost = host
  out.baseHostClass = classifyBaseHost(provider.apiBaseUrl, cfg.upstreamEnvironment, cfg.authEnvironmentAtAuth)
  out.executionConfig = resolveProviderExecutionPolicy(provider)

  // Environment gate.
  if (appEnv !== 'staging' && appEnv !== 'test') {
    gates.environment = 'FAIL'
    blockers.push(`APP_ENV must be staging (got '${appEnv || '(unset)'}')`)
  } else if (out.baseHostClass !== 'STAGING_SAFE') {
    gates.environment = 'FAIL'
    blockers.push(`provider upstream is ${out.baseHostClass} (host ${host || '(none)'}, upstreamEnvironment=${out.upstreamEnvironment || '(unset)'}) — not provably staging/test`)
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
      activePriceSnapshotId: true, isAvailable: true,
    },
    orderBy: { costPrice: 'asc' as any },
    take: 25,
  })
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
    out.testPackage = {
      providerPackageId: candidate.id, providerPlanId: candidate.providerPlanId || undefined,
      classification: classifyTestPackage({
        providerPlanId: candidate.providerPlanId, name: candidate.name, costPrice: candidate.costPrice,
        operatorSupplied: !!input.packageId && (candidate.id === input.packageId || candidate.providerPlanId === input.packageId),
        operatorLabel: candidate.name || candidate.providerPlanId || '',
      }),
      providerCost: candidate.costPrice != null ? Number(candidate.costPrice) : null,
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

  const allPass = Object.values(gates).every((g) => g === 'PASS')
  out.readiness = allPass ? 'READY' : 'BLOCKED'
  return out
}