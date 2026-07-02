'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

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
  const markupPercent = formData.get('markupPercent') ? parseFloat(formData.get('markupPercent') as string) : undefined
  const fixedPrice = formData.get('fixedPrice') ? parseFloat(formData.get('fixedPrice') as string) : undefined
  const sellingCurrency = (formData.get('sellingCurrency') as string) || 'USD'
  const publishStatus = (formData.get('publishStatus') as string) || 'READY'
  const priority = parseInt((formData.get('priority') as string) || '0')
  const isActive = formData.get('isActive') === 'on'

  if (!name) redirect('/admin/package-rules?error=Name required')

  await prisma.packageConfigurationRule.create({
    data: { name, providerId, country, region, productType, dataMinGB, dataMaxGB, validityMinDays, validityMaxDays, markupPercent, fixedPrice, sellingCurrency, publishStatus, priority, isActive },
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
  const markupPercent = formData.get('markupPercent') ? parseFloat(formData.get('markupPercent') as string) : undefined
  const fixedPrice = formData.get('fixedPrice') ? parseFloat(formData.get('fixedPrice') as string) : undefined
  const sellingCurrency = (formData.get('sellingCurrency') as string) || 'USD'
  const publishStatus = (formData.get('publishStatus') as string) || 'READY'
  const priority = parseInt((formData.get('priority') as string) || '0')
  const isActive = formData.get('isActive') === 'on'

  if (!name) redirect('/admin/package-rules?error=Name required')

  const update: any = { name, providerId, country, region, productType, dataMinGB, dataMaxGB, validityMinDays, validityMaxDays, markupPercent, fixedPrice, sellingCurrency, publishStatus, priority, isActive }
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

export async function applyRulesToPackages(packageIds?: string[]): Promise<{ success: boolean; matched?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  // Get active rules ordered by priority (highest first)
  const rules = await prisma.packageConfigurationRule.findMany({
    where: { isActive: true },
    orderBy: { priority: 'desc' },
  })

  if (rules.length === 0) return { success: false, error: 'No active rules configured' }

  // Get packages to process
  const where: any = { configurationStatus: 'UNCONFIGURED' }
  if (packageIds && packageIds.length > 0) where.id = { in: packageIds }

  const packages = await prisma.packageConfigurationRule.findMany as any // dummy
  const providerPackages = await prisma.providerPackage.findMany({ where })

  let matched = 0

  for (const pp of providerPackages) {
    // Find matching rule (highest priority first)
    const rule = rules.find(r => {
      if (r.providerId && r.providerId !== pp.providerId) return false
      if (r.country && r.country !== pp.country) return false
      if (r.region && r.region !== pp.region) return false
      if (r.dataMinGB != null && pp.dataGB < r.dataMinGB) return false
      if (r.dataMaxGB != null && pp.dataGB > r.dataMaxGB) return false
      if (r.validityMinDays != null && pp.validityDays < r.validityMinDays) return false
      if (r.validityMaxDays != null && pp.validityDays > r.validityMaxDays) return false
      return true
    })

    if (!rule) continue

    const costPrice = parseFloat(pp.costPrice.toString())
    let sellingPrice: number | undefined

    if (rule.fixedPrice) {
      sellingPrice = parseFloat(rule.fixedPrice.toString())
    } else if (rule.markupPercent && costPrice > 0) {
      const markup = parseFloat(rule.markupPercent.toString())
      sellingPrice = parseFloat((costPrice * (1 + markup / 100)).toFixed(2))
    }

    if (!sellingPrice || sellingPrice <= 0) continue

    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: {
        sellingPrice,
        sellingCurrency: rule.sellingCurrency,
        markupPercent: rule.markupPercent,
        pricingMode: rule.fixedPrice ? 'FIXED_PRICE' : 'MARKUP_PERCENT',
        publishStatus: rule.publishStatus || 'READY',
        configurationStatus: 'AUTO_CONFIGURED',
        autoConfiguredByRuleId: rule.id,
        lastConfiguredAt: new Date(),
      },
    })

    matched++
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RULES_APPLIED', entity: 'ProviderPackage', details: `Applied ${rules.length} rules to ${matched} packages` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog')
  return { success: true, matched }
}
