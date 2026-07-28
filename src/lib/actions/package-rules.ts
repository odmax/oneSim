'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import { markSellingPriceByPercent } from '@/lib/pricing/pricing-engine'
import { doesRuleMatchPackage, inferPricingStrategy, extractPricingValue } from '@/lib/pricing/pricing-rule-evaluator'
import { buildUpdateRequest } from '@/lib/pricing/pricing-update-service'

export async function createRule(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  const providerId = (formData.get('providerId') as string) || undefined
  const country = (formData.get('country') as string) || undefined
  const region = (formData.get('region') as string) || undefined
  const productType = (formData.get('productType') as string) || undefined
  const dataMinGB = formData.get('dataMinGB') ? parseInt(formData.get('dataMinGB') as string) : undefined
  const dataMaxGB = formData.get('dataMaxGB') ? parseInt(formData.get('dataMaxGB') as string) : undefined
  const validityMinDays = formData.get('validityMinDays') ? parseInt(formData.get('validityMinDays') as string) : undefined
  const validityMaxDays = formData.get('validityMaxDays') ? parseInt(formData.get('validityMaxDays') as string) : undefined
  const costPrice = formData.get('costPrice') ? parseFloat(formData.get('costPrice') as string) : undefined
  const markupPercent = formData.get('markupPercent') ? parseFloat(formData.get('markupPercent') as string) : undefined
  const fixedPrice = formData.get('fixedPrice') ? parseFloat(formData.get('fixedPrice') as string) : undefined
  const sellingCurrency = (formData.get('sellingCurrency') as string) || 'USD'
  const publishStatus = (formData.get('publishStatus') as string) || 'READY'
  const priority = parseInt((formData.get('priority') as string) || '0')
  const isActive = formData.get('isActive') === 'on'

  if (!name) redirect('/admin/package-rules?error=Name required')

  await prisma.packageConfigurationRule.create({
    data: { name, providerId, country, region, productType, dataMinGB, dataMaxGB, validityMinDays, validityMaxDays, costPrice, markupPercent, fixedPrice, sellingCurrency, publishStatus, priority, isActive },
  })

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULE_CREATED', entity: 'PackageConfigurationRule', details: name } }).catch(() => {})
  revalidatePath('/admin/package-rules')
  redirect('/admin/package-rules?success=created')
}

export async function updateRule(ruleId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  const providerId = (formData.get('providerId') as string) || undefined
  const country = (formData.get('country') as string) || undefined
  const region = (formData.get('region') as string) || undefined
  const productType = (formData.get('productType') as string) || undefined
  const dataMinGB = formData.get('dataMinGB') ? parseInt(formData.get('dataMinGB') as string) : undefined
  const dataMaxGB = formData.get('dataMaxGB') ? parseInt(formData.get('dataMaxGB') as string) : undefined
  const validityMinDays = formData.get('validityMinDays') ? parseInt(formData.get('validityMinDays') as string) : undefined
  const validityMaxDays = formData.get('validityMaxDays') ? parseInt(formData.get('validityMaxDays') as string) : undefined
  const costPrice = formData.get('costPrice') ? parseFloat(formData.get('costPrice') as string) : undefined
  const markupPercent = formData.get('markupPercent') ? parseFloat(formData.get('markupPercent') as string) : undefined
  const fixedPrice = formData.get('fixedPrice') ? parseFloat(formData.get('fixedPrice') as string) : undefined
  const sellingCurrency = (formData.get('sellingCurrency') as string) || 'USD'
  const publishStatus = (formData.get('publishStatus') as string) || 'READY'
  const priority = parseInt((formData.get('priority') as string) || '0')
  const isActive = formData.get('isActive') === 'on'

  if (!name) redirect('/admin/package-rules?error=Name required')

  const update: any = { name, providerId, country, region, productType, dataMinGB, dataMaxGB, validityMinDays, validityMaxDays, costPrice, markupPercent, fixedPrice, sellingCurrency, publishStatus, priority, isActive }
  Object.keys(update).forEach(k => { if (update[k] === undefined) delete update[k] })

  await prisma.packageConfigurationRule.update({ where: { id: ruleId }, data: update })
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULE_UPDATED', entity: 'PackageConfigurationRule', entityId: ruleId, details: name } }).catch(() => {})
  revalidatePath('/admin/package-rules')
  redirect('/admin/package-rules?success=updated')
}

export async function deleteRule(ruleId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  await prisma.packageConfigurationRule.delete({ where: { id: ruleId } })
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULE_DELETED', entity: 'PackageConfigurationRule', entityId: ruleId } }).catch(() => {})
  revalidatePath('/admin/package-rules')
  redirect('/admin/package-rules?success=deleted')
}

export async function toggleRuleActive(ruleId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: ruleId } })
  if (!rule) redirect('/admin/package-rules?error=not_found')
  await prisma.packageConfigurationRule.update({ where: { id: ruleId }, data: { isActive: !rule.isActive } })
  revalidatePath('/admin/package-rules')
  redirect('/admin/package-rules?success=toggled')
}

export async function duplicateRule(ruleId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const original = await prisma.packageConfigurationRule.findUnique({ where: { id: ruleId } })
  if (!original) redirect('/admin/package-rules?error=not_found')

  await prisma.packageConfigurationRule.create({
    data: {
      name: `${original.name} (copy)`,
      providerId: original.providerId,
      country: original.country,
      region: original.region,
      productType: original.productType,
      dataMinGB: original.dataMinGB,
      dataMaxGB: original.dataMaxGB,
      validityMinDays: original.validityMinDays,
      validityMaxDays: original.validityMaxDays,
      costPrice: original.costPrice,
      markupPercent: original.markupPercent,
      fixedPrice: original.fixedPrice,
      sellingCurrency: original.sellingCurrency,
      publishStatus: original.publishStatus,
      priority: original.priority,
      isActive: false,
    },
  })

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULE_DUPLICATED', entity: 'PackageConfigurationRule', entityId: ruleId, details: `Duplicated "${original.name}"` } }).catch(() => {})
  revalidatePath('/admin/package-rules')
  redirect('/admin/package-rules?success=duplicated')
}

export async function applyRulesToPackages(packageIds?: string[]): Promise<{ success: boolean; matched?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  try {
    // Get active rules ordered by priority (highest first)
    const rules = await prisma.packageConfigurationRule.findMany({
      where: { isActive: true },
      orderBy: { priority: 'desc' },
    })

    if (rules.length === 0) return { success: false, error: 'No active rules configured' }

    // Get packages to process — include UNCONFIGURED and AUTO_CONFIGURED
    // where the auto-configured rule has been updated since last apply
    const where: any = {
      OR: [
        { configurationStatus: 'UNCONFIGURED' },
        { configurationStatus: 'AUTO_CONFIGURED' },
      ],
    }
    if (packageIds && packageIds.length > 0) where.id = { in: packageIds }

    const providerPackages = await prisma.providerPackage.findMany({
      where,
      include: { configuredByRule: { select: { id: true, updatedAt: true } } },
    })

    const matchedUpdates: { pp: typeof providerPackages[number]; updateData: any }[] = []

    for (const pp of providerPackages) {
      const rule = rules.find(r => doesRuleMatchPackage(r as any, pp as any))

      if (!rule) continue

      const ruleUpdatedSince = pp.lastConfiguredAt && rule.updatedAt > pp.lastConfiguredAt
      const needsReconfigure = pp.configurationStatus === 'UNCONFIGURED' || ruleUpdatedSince

      if (!needsReconfigure && pp.configurationStatus !== 'UNCONFIGURED') continue

      let effectiveCost = parseFloat(pp.costPrice.toString())
      if (rule.costPrice && parseFloat(rule.costPrice.toString()) > 0) {
        if (effectiveCost <= 0 || (ruleUpdatedSince && pp.autoConfiguredByRuleId === rule.id)) {
          effectiveCost = parseFloat(rule.costPrice.toString())
        }
      }

      const strategy = inferPricingStrategy(rule as any)
      const pricingValue = extractPricingValue(rule as any)

      let sellingPrice: number | undefined
      if (strategy === 'FIXED_SELLING_PRICE' && pricingValue != null) {
        sellingPrice = pricingValue
      } else if (strategy === 'MARKUP_PERCENT' && pricingValue != null && effectiveCost > 0) {
        sellingPrice = markSellingPriceByPercent(effectiveCost, pricingValue)
      }

      if (!sellingPrice || sellingPrice <= 0) continue

      const updateData = {
        ...buildUpdateRequest({
          packageId: pp.id,
          ruleId: rule.id,
          ruleName: rule.name,
          sellingPrice: sellingPrice!,
          sellingCurrency: rule.sellingCurrency,
          markupPercent: rule.markupPercent ? parseFloat(rule.markupPercent.toString()) : null,
          pricingMode: rule.fixedPrice ? 'FIXED_PRICE' : 'MARKUP_PERCENT',
          publishStatus: rule.publishStatus || 'READY',
          costPrice: effectiveCost !== parseFloat(pp.costPrice.toString()) ? effectiveCost : undefined,
        }),
        lastConfiguredAt: new Date(),
      }

      matchedUpdates.push({ pp, updateData })
    }

    if (matchedUpdates.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const { pp, updateData } of matchedUpdates) {
          await tx.providerPackage.update({ where: { id: pp.id }, data: updateData })
          const merged = { ...pp, ...updateData }
          await syncProviderPackageToPublishedProducts(tx, merged as any)
        }
      })
    }

    await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULES_APPLIED', entity: 'ProviderPackage', details: `Applied ${rules.length} rules to ${matchedUpdates.length} packages` } }).catch(() => {})
    await revalidateCatalogRoutes()
    return { success: true, matched: matchedUpdates.length }
  } catch (e: any) {
    console.error('[applyRulesToPackages] Failed:', e)
    return { success: false, error: e.message || 'Rules application failed' }
  }
}
