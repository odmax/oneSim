'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'

export interface ApplyRuleFilters {
  providerId?: string
  country?: string
  region?: string
  network?: string
  publishStatus?: string
  configurationStatus?: string
  hasCostPrice?: boolean
  hasSellingPrice?: boolean
  hasValidity?: boolean
  hasDataAllowance?: boolean
  includeArchived?: boolean
  includeHidden?: boolean
}

export interface SkipReason {
  reason: string
  count: number
  examples: { id: string; name: string }[]
}

export interface ApplyRulePreview {
  ruleId: string
  ruleName: string
  scope: string
  filters: ApplyRuleFilters
  matched: number
  skipped: number
  skipReasons: SkipReason[]
  totalInScope: number
  estimatedTimeMs: number
}

export interface ApplyRuleResult {
  success: boolean
  executionId?: string
  matched?: number
  skipped?: number
  failed?: number
  skipReasons?: { reason: string; count: number }[]
  error?: string
}

export interface RuleExecutionSummary {
  id: string
  ruleId: string
  ruleName: string
  executedBy: string | null
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
  scope: string
  totalMatched: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  status: string
}

export async function getApplyRulePreview(
  ruleId: string,
  scope: string,
  filters: ApplyRuleFilters,
  selectedIds?: string[],
): Promise<{ success: boolean; data?: ApplyRulePreview; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: ruleId } })
  if (!rule) return { success: false, error: 'Rule not found' }

  const where: any = buildScopeWhere(scope, filters, selectedIds)
  if (filters.includeArchived) delete where.ARCHIVED
  if (filters.includeHidden) delete where.HIDDEN

  const packages = await prisma.providerPackage.findMany({
    where,
    select: { id: true, name: true, costPrice: true, sellingPrice: true, publishStatus: true, configurationStatus: true, dataGB: true, validityDays: true, providerId: true, country: true, region: true, autoConfiguredByRuleId: true },
  })

  let matched = 0
  let skipped = 0
  const skipReasonsMap: Record<string, { count: number; examples: { id: string; name: string }[] }> = {}

  function addSkip(reason: string, pkg: { id: string; name: string }) {
    if (!skipReasonsMap[reason]) skipReasonsMap[reason] = { count: 0, examples: [] }
    skipReasonsMap[reason].count++
    if (skipReasonsMap[reason].examples.length < 3) {
      skipReasonsMap[reason].examples.push({ id: pkg.id, name: pkg.name })
    }
  }

  for (const pkg of packages) {
    if (!matchesRule(rule, pkg)) {
      addSkip('Does not match rule criteria', pkg)
      skipped++
      continue
    }

    const cost = parseFloat(pkg.costPrice.toString())
    if (!cost || cost <= 0) {
      addSkip('Missing cost price', pkg)
      skipped++
      continue
    }

    if (rule.markupPercent && cost <= 0) {
      addSkip('Markup requires cost price', pkg)
      skipped++
      continue
    }

    if (pkg.publishStatus === 'PUBLISHED' && !filters.includeArchived) {
      addSkip('Already published', pkg)
      skipped++
      continue
    }

    if (pkg.autoConfiguredByRuleId === ruleId) {
      addSkip('Already processed by this rule', pkg)
      skipped++
      continue
    }

    matched++
  }

  return {
    success: true,
    data: {
      ruleId: rule.id,
      ruleName: rule.name,
      scope,
      filters,
      matched,
      skipped,
      skipReasons: Object.entries(skipReasonsMap).map(([reason, info]) => ({
        reason,
        count: info.count,
        examples: info.examples,
      })),
      totalInScope: packages.length,
      estimatedTimeMs: Math.max(1000, matched * 50),
    },
  }
}

export async function executeApplyRule(
  ruleId: string,
  scope: string,
  filters: ApplyRuleFilters,
  selectedIds?: string[],
): Promise<ApplyRuleResult> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  try {
    const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: ruleId } })
    if (!rule) return { success: false, error: 'Rule not found' }
    if (!rule.isActive) return { success: false, error: 'Rule is inactive — activate it first' }

    const where: any = buildScopeWhere(scope, filters, selectedIds)
    if (filters.includeArchived) delete where.ARCHIVED
    if (filters.includeHidden) delete where.HIDDEN

    const packages = await prisma.providerPackage.findMany({
      where,
      select: { id: true, name: true, costPrice: true, sellingPrice: true, sellingCurrency: true, markupPercent: true, pricingMode: true, publishStatus: true, configurationStatus: true, dataGB: true, validityDays: true, providerId: true, country: true, region: true, autoConfiguredByRuleId: true, lastConfiguredAt: true },
    })

    let matched = 0
    let skipped = 0
    let failed = 0
    const skipReasonsMap: Record<string, number> = {}
    const skipDetails: { id: string; name: string; reason: string }[] = []
    const matchedUpdates: { pkg: typeof packages[number]; updateData: any }[] = []
    const startedAt = new Date()

    const execution = await prisma.ruleExecution.create({
      data: {
        ruleId,
        ruleName: rule.name,
        executedById: session.user.id,
        startedAt,
        scope,
        filtersUsed: { scope, ...filters },
        status: 'RUNNING',
      },
    })

    for (const pkg of packages) {
      if (!matchesRule(rule, pkg)) {
        skipped++
        skipReasonsMap['Does not match rule criteria'] = (skipReasonsMap['Does not match rule criteria'] || 0) + 1
        skipDetails.push({ id: pkg.id, name: pkg.name, reason: 'Does not match rule criteria' })
        continue
      }

      let effectiveCost = parseFloat(pkg.costPrice.toString())
      if (!effectiveCost || effectiveCost <= 0) {
        skipped++
        skipReasonsMap['Missing cost price'] = (skipReasonsMap['Missing cost price'] || 0) + 1
        skipDetails.push({ id: pkg.id, name: pkg.name, reason: 'Missing cost price' })
        continue
      }

      if (rule.costPrice && parseFloat(rule.costPrice.toString()) > 0) {
        effectiveCost = parseFloat(rule.costPrice.toString())
      }

      let sellingPrice: number | undefined
      if (rule.fixedPrice && parseFloat(rule.fixedPrice.toString()) > 0) {
        sellingPrice = parseFloat(rule.fixedPrice.toString())
      } else if (rule.markupPercent && effectiveCost > 0) {
        const markup = parseFloat(rule.markupPercent.toString())
        sellingPrice = parseFloat((effectiveCost * (1 + markup / 100)).toFixed(2))
      }

      if (!sellingPrice || sellingPrice <= 0) {
        skipped++
        skipReasonsMap['Could not compute selling price'] = (skipReasonsMap['Could not compute selling price'] || 0) + 1
        skipDetails.push({ id: pkg.id, name: pkg.name, reason: 'Could not compute selling price' })
        continue
      }

      if (pkg.publishStatus === 'PUBLISHED') {
        skipped++
        skipReasonsMap['Already published'] = (skipReasonsMap['Already published'] || 0) + 1
        skipDetails.push({ id: pkg.id, name: pkg.name, reason: 'Already published' })
        continue
      }

      if (pkg.autoConfiguredByRuleId === ruleId) {
        skipped++
        skipReasonsMap['Already processed by this rule'] = (skipReasonsMap['Already processed by this rule'] || 0) + 1
        skipDetails.push({ id: pkg.id, name: pkg.name, reason: 'Already processed by this rule' })
        continue
      }

      try {
        const updateData: any = {
          sellingPrice,
          sellingCurrency: rule.sellingCurrency,
          markupPercent: rule.markupPercent,
          pricingMode: rule.fixedPrice ? 'FIXED_PRICE' : 'MARKUP_PERCENT',
          publishStatus: rule.publishStatus || 'READY',
          configurationStatus: 'AUTO_CONFIGURED',
          autoConfiguredByRuleId: rule.id,
          lastConfiguredAt: new Date(),
        }

        if (effectiveCost !== parseFloat(pkg.costPrice.toString())) {
          updateData.costPrice = effectiveCost
        }

        matched++
        matchedUpdates.push({ pkg, updateData })
      } catch {
        failed++
      }
    }

    if (matchedUpdates.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const { pkg, updateData } of matchedUpdates) {
          await tx.providerPackage.update({ where: { id: pkg.id }, data: updateData })
          const merged = { ...pkg, ...updateData }
          await syncProviderPackageToPublishedProducts(tx, merged as any)
        }
      })
    }

    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()

    await prisma.ruleExecution.update({
      where: { id: execution.id },
      data: {
        finishedAt,
        durationMs,
        totalMatched: packages.length,
        updatedCount: matched,
        skippedCount: skipped,
        failedCount: failed,
        skipDetails: skipDetails.length > 0 ? JSON.parse(JSON.stringify(skipDetails)) : undefined,
        status: 'COMPLETED',
      },
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'RULE_APPLIED',
        entity: 'RuleExecution',
        entityId: execution.id,
        details: `Rule "${rule.name}" applied: ${matched} updated, ${skipped} skipped, ${failed} failed`,
      },
    }).catch(() => {})

    await prisma.catalogChangeSet.create({
      data: {
        actionType: 'RULES_APPLIED',
        description: `Applied "${rule.name}" — ${matched} updated, ${skipped} skipped`,
        createdById: session.user.id,
        totalChanged: matched,
        metadata: { ruleId, executionId: execution.id },
      },
    }).catch(() => {})

    await revalidateCatalogRoutes()
    revalidatePath('/admin/package-rules')
    return {
      success: true,
      executionId: execution.id,
      matched,
      skipped,
      failed,
      skipReasons: Object.entries(skipReasonsMap).map(([reason, count]) => ({ reason, count })),
    }
  } catch (e: any) {
    console.error('[executeApplyRule] Failed:', e)
    return { success: false, error: e.message || 'Rule execution failed' }
  }
}

export async function getRuleExecutionHistory(
  ruleId?: string,
  page: number = 1,
  limit: number = 20,
): Promise<{ executions: RuleExecutionSummary[]; total: number; page: number; totalPages: number }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { executions: [], total: 0, page: 1, totalPages: 0 }

  const where: any = {}
  if (ruleId) where.ruleId = ruleId

  const [executions, total] = await Promise.all([
    prisma.ruleExecution.findMany({
      where,
      include: { executedBy: { select: { name: true } } },
      orderBy: { executedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.ruleExecution.count({ where }),
  ])

  return {
    executions: executions.map(e => ({
      id: e.id,
      ruleId: e.ruleId,
      ruleName: e.ruleName,
      executedBy: e.executedBy?.name || null,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      durationMs: e.durationMs,
      scope: e.scope,
      totalMatched: e.totalMatched,
      updatedCount: e.updatedCount,
      skippedCount: e.skippedCount,
      failedCount: e.failedCount,
      status: e.status,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  }
}

export async function getRuleExecutionDetail(executionId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return null

  return prisma.ruleExecution.findUnique({
    where: { id: executionId },
    include: { executedBy: { select: { name: true } }, rule: { select: { name: true, id: true } } },
  })
}

export async function getRuleLastUsed(ruleId: string): Promise<Date | null> {
  const last = await prisma.ruleExecution.findFirst({
    where: { ruleId, status: 'COMPLETED' },
    orderBy: { executedAt: 'desc' },
    select: { executedAt: true },
  })
  return last?.executedAt || null
}

export async function getRuleTimesApplied(ruleId: string): Promise<number> {
  return prisma.ruleExecution.count({
    where: { ruleId, status: 'COMPLETED' },
  })
}

function buildScopeWhere(scope: string, filters: ApplyRuleFilters, selectedIds?: string[]): any {
  const where: any = {}

  if (scope === 'unconfigured') {
    where.configurationStatus = 'UNCONFIGURED'
    where.publishStatus = { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] }
  } else if (scope === 'configured') {
    where.configurationStatus = { in: ['CONFIGURED', 'AUTO_CONFIGURED'] }
  } else if (scope === 'draft') {
    where.publishStatus = 'DRAFT'
  } else if (scope === 'all_eligible') {
    where.OR = [
      { configurationStatus: 'UNCONFIGURED' },
      { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
      { publishStatus: 'DRAFT' },
    ]
    where.publishStatus = { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] }
  } else if (scope === 'selected') {
    if (selectedIds && selectedIds.length > 0) where.id = { in: selectedIds }
  }

  if (filters.providerId) where.providerId = filters.providerId
  if (filters.country) where.country = filters.country
  if (filters.region) where.region = filters.region
  if (filters.publishStatus) where.publishStatus = filters.publishStatus
  if (filters.configurationStatus) where.configurationStatus = filters.configurationStatus
  if (filters.hasCostPrice) where.costPrice = { gt: 0 }
  if (filters.hasSellingPrice) where.sellingPrice = { gt: 0 }
  if (filters.hasValidity) where.validityDays = { gt: 0 }
  if (filters.hasDataAllowance) where.dataGB = { gt: 0 }

  const publishExcludes: string[] = []
  if (!filters.includeArchived) publishExcludes.push('ARCHIVED')
  if (!filters.includeHidden) publishExcludes.push('HIDDEN')

  if (publishExcludes.length === 1) {
    where.publishStatus = { not: publishExcludes[0] }
  } else if (publishExcludes.length === 2) {
    where.publishStatus = { notIn: publishExcludes }
  }

  return where
}

function matchesRule(rule: any, pkg: any): boolean {
  if (rule.providerId && rule.providerId !== pkg.providerId) return false
  if (rule.country && rule.country !== pkg.country) return false
  if (rule.region && rule.region !== pkg.region) return false
  if (rule.dataMinGB != null && pkg.dataGB < rule.dataMinGB) return false
  if (rule.dataMaxGB != null && pkg.dataGB > rule.dataMaxGB) return false
  if (rule.validityMinDays != null && pkg.validityDays < rule.validityMinDays) return false
  if (rule.validityMaxDays != null && pkg.validityDays > rule.validityMaxDays) return false
  return true
}
