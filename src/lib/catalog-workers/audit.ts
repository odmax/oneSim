import { prisma } from '@/lib/prisma'

export interface AuditFinding {
  severity: 'ERROR' | 'WARNING' | 'INFO'
  category: string
  message: string
  packageId?: string
  comparableKey?: string
  repairSuggestion?: string
}

export interface AuditResult {
  findings: AuditFinding[]
  summary: {
    errors: number
    warnings: number
    infos: number
    totalPackages: number
    totalGroups: number
  }
}

export async function catalogPipelineAudit(): Promise<AuditResult> {
  const findings: AuditFinding[] = []

  const allPackages = await prisma.providerPackage.findMany({
    include: {
      provider: { select: { id: true, name: true, code: true, status: true } },
      publishedAs: { select: { id: true, isActive: true, archivedAt: true, hiddenFromCatalog: true } },
    },
  })

  const groups = new Map<string, typeof allPackages>()
  for (const pkg of allPackages) {
    if (pkg.comparableKey) {
      const existing = groups.get(pkg.comparableKey) || []
      existing.push(pkg)
      groups.set(pkg.comparableKey, existing)
    }
  }

  // 1. Check cheapest winner matches published winner
  for (const [key, group] of groups) {
    const cheapestWinner = group.find(p => p.isCheapestCandidate && p.isAvailable)
    const publishedWinner = group.find(p => p.publishStatus === 'PUBLISHED' && p.isAvailable)

    if (cheapestWinner && publishedWinner && cheapestWinner.id !== publishedWinner.id) {
      findings.push({
        severity: 'ERROR',
        category: 'WINNER_MISMATCH',
        message: `Cheapest winner ${cheapestWinner.id} differs from published winner ${publishedWinner.id} in group ${key}`,
        packageId: cheapestWinner.id,
        comparableKey: key,
        repairSuggestion: `Recalculate group ${key} to reconcile winner`,
      })
    }

    if (!cheapestWinner && publishedWinner) {
      findings.push({
        severity: 'WARNING',
        category: 'NO_CHEAPEST_WINNER',
        message: `Published package ${publishedWinner.id} in group ${key} has no cheapest candidate`,
        packageId: publishedWinner.id,
        comparableKey: key,
        repairSuggestion: `Run recalculateComparableGroup('${key}') to select a winner`,
      })
    }

    if (cheapestWinner && !publishedWinner) {
      const esimCheck = cheapestWinner.publishedAs
      if (esimCheck && esimCheck.isActive && !esimCheck.archivedAt && !esimCheck.hiddenFromCatalog) {
        findings.push({
          severity: 'INFO',
          category: 'NO_PUBLISHED_PACKAGE',
          message: `Group ${key} has cheapest winner ${cheapestWinner.id} but no PUBLISHED package (eSIM exists)`,
          comparableKey: key,
          repairSuggestion: `Set publishStatus='PUBLISHED' on ${cheapestWinner.id}`,
        })
      }
    }
  }

  // 2. Check for missing comparableKey on available packages
  for (const pkg of allPackages) {
    if (pkg.isAvailable && !pkg.comparableKey) {
      findings.push({
        severity: 'WARNING',
        category: 'MISSING_COMPARABLE_KEY',
        message: `Available package ${pkg.id} (${pkg.name}) has no comparableKey`,
        packageId: pkg.id,
        repairSuggestion: `Run recalculateCheapestPlans() to compute comparable keys`,
      })
    }
  }

  // 3. No duplicate published packages in the same group
  for (const [key, group] of groups) {
    const published = group.filter(p => p.publishStatus === 'PUBLISHED' && p.isAvailable)
    if (published.length > 1) {
      findings.push({
        severity: 'ERROR',
        category: 'DUPLICATE_PUBLISHED',
        message: `Group ${key} has ${published.length} PUBLISHED packages`,
        comparableKey: key,
        repairSuggestion: `Unpublish all but the cheapest winner in group ${key}`,
      })
    }
  }

  // 4. No READY package excluded unexpectedly
  for (const pkg of allPackages) {
    if (pkg.publishStatus === 'READY' && pkg.excludedFromCheapest && !pkg.exclusionReason) {
      findings.push({
        severity: 'WARNING',
        category: 'EXCLUDED_WITHOUT_REASON',
        message: `Package ${pkg.id} is READY but excluded without reason`,
        packageId: pkg.id,
        comparableKey: pkg.comparableKey || undefined,
        repairSuggestion: `Add exclusionReason or remove exclusion`,
      })
    }
  }

  // 5. No orphaned published package (published but not available)
  for (const pkg of allPackages) {
    if (pkg.publishStatus === 'PUBLISHED' && !pkg.isAvailable) {
      findings.push({
        severity: 'ERROR',
        category: 'ORPHANED_PUBLISHED',
        message: `Package ${pkg.id} is PUBLISHED but not available`,
        packageId: pkg.id,
        comparableKey: pkg.comparableKey || undefined,
        repairSuggestion: `Set publishStatus='HIDDEN' or re-enable isAvailable`,
      })
    }
  }

  // 6. Marketplace products exist for published packages
  const publishedPackages = allPackages.filter(p => p.publishStatus === 'PUBLISHED' && p.isAvailable)
  for (const pkg of publishedPackages) {
    if (!pkg.publishedAs || !pkg.publishedAs.isActive) {
      findings.push({
        severity: 'WARNING',
        category: 'MISSING_MARKETPLACE_PRODUCT',
        message: `Published package ${pkg.id} has no active marketplace product`,
        packageId: pkg.id,
        comparableKey: pkg.comparableKey || undefined,
        repairSuggestion: `Create or reactivate eSIMPackage for providerPackage ${pkg.id}`,
      })
    }
  }

  // 7. Check inactive marketplace products for non-published packages
  const nonPublishedIds = new Set(
    allPackages.filter(p => p.publishStatus !== 'PUBLISHED').map(p => p.id),
  )
  const orphanedMarketplace = await prisma.eSIMPackage.findMany({
    where: {
      providerPackageId: { in: [...nonPublishedIds] },
      isActive: true,
      source: 'CATALOG_PRODUCT',
    },
    select: { id: true, providerPackageId: true, name: true },
  })
  for (const mp of orphanedMarketplace) {
    findings.push({
      severity: 'WARNING',
      category: 'ORPHANED_MARKETPLACE',
      message: `Marketplace product ${mp.id} (${mp.name}) is active but linked to non-published package`,
      packageId: mp.providerPackageId || undefined,
      repairSuggestion: `Deactivate or hide marketplace product ${mp.id}`,
    })
  }

  const errors = findings.filter(f => f.severity === 'ERROR').length
  const warnings = findings.filter(f => f.severity === 'WARNING').length
  const infos = findings.filter(f => f.severity === 'INFO').length

  return {
    findings,
    summary: {
      errors,
      warnings,
      infos,
      totalPackages: allPackages.length,
      totalGroups: groups.size,
    },
  }
}

export async function catalogPipelineAuditSummary(): Promise<{
  audit: AuditResult
  timestamp: string
}> {
  const audit = await catalogPipelineAudit()
  return {
    audit,
    timestamp: new Date().toISOString(),
  }
}
