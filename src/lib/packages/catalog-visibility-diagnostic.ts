/**
 * Catalog visibility diagnostic — pure aggregation logic.
 *
 * READ-ONLY. This module contains NO database writes, NO provider calls,
 * NO publishing, NO price recalculation, and NO snapshot creation. It only
 * aggregates the results of canonical helpers (getPackagePurchaseReadiness,
 * capability exposure) into a stage-by-stage pipeline report so the exact
 * drop point can be identified with counts and exact reasons.
 *
 * The pure functions here are exercised by unit tests; the CLI in
 * scripts/diag-catalog-visibility.ts loads data with Prisma reads and feeds
 * it into these functions.
 */

import { getPackagePurchaseReadiness } from './purchase-readiness'

/** Minimal retail candidate shape — subset of ESIMPackage the readiness check needs. */
export interface DiagnosticRetailCandidate {
  id: string
  displayName?: string | null
  name: string
  isActive: boolean
  hiddenFromCatalog: boolean | null
  archivedAt: Date | string | null
  source: string
  providerPackageId: string | null
  priceUSD?: unknown
  providerPackage: {
    id: string
    providerId: string | null
    costStatus: string | null
    pricingStatus: string | null
    publishStatus: string | null
    configurationStatus: string | null
    activePriceSnapshotId: string | null
    sellingPrice: unknown
    costPrice: unknown
  } | null
  provider: {
    id: string
    code: string | null
    status: string | null
    enabledCapabilities: unknown
  } | null
}

/** Minimal provider shape for the exposure diagnostic. */
export interface DiagnosticProviderInfo {
  id: string
  code: string | null
  status: string | null
  adapterStrategy?: string | null
  enabledCapabilities?: unknown
}

/** Safe exposure state — booleans only, never credentials. */
export interface DiagnosticExposureState {
  portalPurchase: boolean
  apiPurchase: boolean
}

export interface DiagnosticPerPackage {
  id: string
  providerCode: string | null
  purchaseReady: boolean
  purchaseReasons: string[]
  portalExposed: boolean
  apiExposed: boolean
}

export interface DiagnosticProviderSummary {
  providerId: string
  code: string | null
  status: string | null
  adapterStrategy: string | null
  enabledCapabilities: string[] | null
  portalPurchaseExposure: boolean
  apiPurchaseExposure: boolean
}

export interface DiagnosticReasonCount {
  reason: string
  count: number
}

export interface CatalogVisibilityReport {
  /** Count of retail candidates (ESIMPackage isActive + source CATALOG_PRODUCT/MANUAL). */
  initialRetailCandidates: number
  /** Per-provider breakdown of initial candidates. */
  initialByProvider: Array<{ providerCode: string | null; count: number }>
  /** Count passing getPackagePurchaseReadiness. */
  purchaseReady: number
  purchaseNotReady: number
  /** Aggregated exact canonical readiness rejection reasons. */
  purchaseReasons: DiagnosticReasonCount[]
  /** Per-package readiness + exposure detail (CHOICE pipeline uses this). */
  packages: DiagnosticPerPackage[]
  /** Portal exposure counts over purchase-ready packages. */
  portalExposureAllowed: number
  portalExposureDenied: number
  /** API exposure counts over purchase-ready packages. */
  apiExposureAllowed: number
  apiExposureDenied: number
  /** Final counts after readiness + exposure (mirrors queryPurchasablePackages). */
  portalFinal: number
  apiFinal: number
  /** Provider summaries for involved providers (safe fields only). */
  providers: DiagnosticProviderSummary[]
  /** Choice-specific pipeline counts. */
  choice: {
    initial: number
    purchaseReady: number
    purchaseNotReady: number
    portalExposed: number
    apiExposed: number
    portalFinal: number
    apiFinal: number
    reasons: DiagnosticReasonCount[]
  }
}

export function aggregateReasons(reasonsList: string[][]): DiagnosticReasonCount[] {
  const counts = new Map<string, number>()
  for (const reasons of reasonsList) {
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

export interface DiagnosticInput {
  candidates: DiagnosticRetailCandidate[]
  /** Exposure per provider id — resolved by the caller (reads exposure table or defaults). */
  exposureByProvider: Record<string, DiagnosticExposureState>
  /** Provider info for involved providers (safe fields only). */
  providerInfo: Record<string, DiagnosticProviderInfo>
}

/**
 * Canonical stage-by-stage aggregation.
 *
 * Stages:
 *   A. initial retail candidates
 *   B. purchase readiness (getPackagePurchaseReadiness)
 *   C. portal exposure (isCapabilityExposedToPortal(PURCHASE))
 *   D. api exposure (isCapabilityExposedToApi(PURCHASE))
 *   E. final portal / api counts
 *
 * Never mutates input. Returns pure numbers + reasons.
 */
export function analyzeCatalogVisibility(input: DiagnosticInput): CatalogVisibilityReport {
  const { candidates, exposureByProvider, providerInfo } = input

  const initialByProviderMap = new Map<string | null, number>()
  for (const c of candidates) {
    const code = c.provider?.code || c.providerPackage?.providerId || null
    initialByProviderMap.set(code, (initialByProviderMap.get(code) || 0) + 1)
  }
  const initialByProvider = Array.from(initialByProviderMap.entries())
    .map(([providerCode, count]) => ({ providerCode, count }))
    .sort((a, b) => (b.count || 0) - (a.count || 0))

  const packages: DiagnosticPerPackage[] = []
  const rejectionReasons: string[][] = []

  for (const c of candidates) {
    const readiness = getPackagePurchaseReadiness({
      pkg: {
        isActive: c.isActive,
        hiddenFromCatalog: c.hiddenFromCatalog ?? undefined,
        archivedAt: c.archivedAt instanceof Date ? c.archivedAt : (c.archivedAt ? new Date(c.archivedAt) : null),
        source: c.source,
        providerPackageId: c.providerPackageId,
      },
      providerPkg: c.providerPackage,
      provider: c.provider ? { status: c.provider.status || '', enabledCapabilities: c.provider.enabledCapabilities, code: c.provider.code } : null,
    })

    const providerId = c.provider?.id || c.providerPackage?.providerId
    const exposure = providerId ? exposureByProvider[providerId] : null
    const portalExposed = exposure?.portalPurchase ?? false
    const apiExposed = exposure?.apiPurchase ?? false

    packages.push({
      id: c.id,
      providerCode: c.provider?.code || null,
      purchaseReady: readiness.ready,
      purchaseReasons: readiness.reasons,
      portalExposed,
      apiExposed,
    })
    if (!readiness.ready) rejectionReasons.push(readiness.reasons)
  }

  const purchaseReady = packages.filter(p => p.purchaseReady)
  const purchaseNotReady = packages.length - purchaseReady.length

  const readyForPortal = purchaseReady.filter(p => p.portalExposed)
  const readyForApi = purchaseReady.filter(p => p.apiExposed)
  const portalExposureAllowed = purchaseReady.filter(p => p.portalExposed).length
  const portalExposureDenied = purchaseReady.filter(p => !p.portalExposed).length
  const apiExposureAllowed = purchaseReady.filter(p => p.apiExposed).length
  const apiExposureDenied = purchaseReady.filter(p => !p.apiExposed).length

  const choicePackages = packages.filter(p => p.providerCode === 'CHOICE')
  const choiceReady = choicePackages.filter(p => p.purchaseReady)
  const choiceRejectionReasons = choicePackages.filter(p => !p.purchaseReady).map(p => p.purchaseReasons)

  const providers = Object.entries(providerInfo).map(([providerId, info]) => {
    const exposure = exposureByProvider[providerId]
    const caps = Array.isArray(info.enabledCapabilities) ? (info.enabledCapabilities as unknown[]).map(String) : null
    return {
      providerId,
      code: info.code,
      status: info.status,
      adapterStrategy: info.adapterStrategy || null,
      enabledCapabilities: caps,
      portalPurchaseExposure: exposure?.portalPurchase ?? false,
      apiPurchaseExposure: exposure?.apiPurchase ?? false,
    }
  })

  return {
    initialRetailCandidates: candidates.length,
    initialByProvider,
    purchaseReady: purchaseReady.length,
    purchaseNotReady,
    purchaseReasons: aggregateReasons(rejectionReasons),
    packages,
    portalExposureAllowed,
    portalExposureDenied,
    apiExposureAllowed,
    apiExposureDenied,
    portalFinal: readyForPortal.length,
    apiFinal: readyForApi.length,
    providers,
    choice: {
      initial: choicePackages.length,
      purchaseReady: choiceReady.length,
      purchaseNotReady: choicePackages.length - choiceReady.length,
      portalExposed: choiceReady.filter(p => p.portalExposed).length,
      apiExposed: choiceReady.filter(p => p.apiExposed).length,
      portalFinal: choiceReady.filter(p => p.portalExposed).length,
      apiFinal: choiceReady.filter(p => p.apiExposed).length,
      reasons: aggregateReasons(choiceRejectionReasons),
    },
  }
}

export function formatCatalogVisibilityReport(report: CatalogVisibilityReport): string {
  const lines: string[] = []
  lines.push('CATALOG VISIBILITY DIAGNOSTIC')
  lines.push('READ ONLY')
  lines.push('')
  lines.push(`INITIAL_RETAIL_CANDIDATES=${report.initialRetailCandidates}`)
  for (const row of report.initialByProvider) {
    lines.push(`  ${row.providerCode || '(no provider)'}: ${row.count}`)
  }
  lines.push('')
  lines.push(`PURCHASE_READY=${report.purchaseReady}`)
  lines.push(`PURCHASE_NOT_READY=${report.purchaseNotReady}`)
  lines.push('')
  lines.push('PURCHASE_REASONS (exact canonical):')
  if (report.purchaseReasons.length === 0) {
    lines.push('  (none)')
  } else {
    for (const r of report.purchaseReasons) {
      lines.push(`  ${r.reason}: ${r.count}`)
    }
  }
  lines.push('')
  lines.push(`PORTAL_EXPOSURE_ALLOWED=${report.portalExposureAllowed}`)
  lines.push(`PORTAL_EXPOSURE_DENIED=${report.portalExposureDenied}`)
  lines.push(`API_EXPOSURE_ALLOWED=${report.apiExposureAllowed}`)
  lines.push(`API_EXPOSURE_DENIED=${report.apiExposureDenied}`)
  lines.push('')
  lines.push(`PORTAL_FINAL_COUNT=${report.portalFinal}`)
  lines.push(`API_FINAL_COUNT=${report.apiFinal}`)
  lines.push('')
  lines.push('PROVIDERS:')
  for (const p of report.providers) {
    lines.push(`  ${p.code || p.providerId} status=${p.status} adapter=${p.adapterStrategy} caps=${p.enabledCapabilities ? p.enabledCapabilities.join(',') : '(default)'} portalPurchase=${p.portalPurchaseExposure} apiPurchase=${p.apiPurchaseExposure}`)
  }
  lines.push('')
  lines.push('CHOICE PIPELINE:')
  lines.push(`  CHOICE_INITIAL=${report.choice.initial}`)
  lines.push(`  CHOICE_PURCHASE_READY=${report.choice.purchaseReady}`)
  lines.push(`  CHOICE_PURCHASE_NOT_READY=${report.choice.purchaseNotReady}`)
  if (report.choice.reasons.length > 0) {
    lines.push('  CHOICE_REASONS (exact):')
    for (const r of report.choice.reasons) {
      lines.push(`    ${r.reason}: ${r.count}`)
    }
  }
  lines.push(`  CHOICE_PORTAL_EXPOSED=${report.choice.portalExposed}`)
  lines.push(`  CHOICE_API_EXPOSED=${report.choice.apiExposed}`)
  lines.push(`  CHOICE_PORTAL_FINAL=${report.choice.portalFinal}`)
  lines.push(`  CHOICE_API_FINAL=${report.choice.apiFinal}`)
  lines.push('')
  lines.push('NO DATABASE WRITE')
  lines.push('NO PROVIDER CALL')
  lines.push('NO PUBLISH')
  lines.push('NO SYNC')
  return lines.join('\n')
}
