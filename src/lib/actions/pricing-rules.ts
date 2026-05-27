'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'

export async function createPricingRule(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  const description = formData.get('description') as string
  const ruleType = formData.get('ruleType') as string
  const ruleMode = formData.get('ruleMode') as string
  const value = formData.get('value') as string
  const priority = parseInt(formData.get('priority') as string) || 0
  const businessId = formData.get('businessId') as string || null
  const region = formData.get('region') as string || null
  const country = formData.get('country') as string || null
  const packageId = formData.get('packageId') as string || null
  const packageType = formData.get('packageType') as string || null
  const startDate = formData.get('startDate') as string || null
  const endDate = formData.get('endDate') as string || null

  if (!name || !ruleType || !ruleMode || !value) {
    redirect('/admin/pricing-rules/new?error=Name,+type,+mode,+and+value+are+required')
  }

  const data: any = {
    name,
    description: description || null,
    ruleType,
    ruleMode,
    value: parseFloat(value),
    priority,
    createdBy: session.user.id,
  }

  if (businessId) data.businessId = businessId
  if (region) data.region = region
  if (country) data.country = country
  if (packageId) data.packageId = packageId
  if (packageType) data.packageType = packageType
  if (startDate) data.startDate = new Date(startDate)
  if (endDate) data.endDate = new Date(endDate)

  try {
    await prisma.pricingRule.create({ data })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'CREATE', entity: 'PricingRule', entityId: name, details: `Created pricing rule: ${name}` },
    })
    revalidatePath('/admin/pricing-rules')
    redirect('/admin/pricing-rules?success=Rule+created')
  } catch (error: any) {
    redirect(`/admin/pricing-rules/new?error=${encodeURIComponent(error.message || 'Failed to create rule')}`)
  }
}

export async function updatePricingRule(ruleId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const rule = await prisma.pricingRule.findUnique({ where: { id: ruleId } })
  if (!rule) redirect('/admin/pricing-rules?error=Rule+not+found')

  const name = formData.get('name') as string || rule.name
  const description = formData.get('description') as string
  const ruleType = formData.get('ruleType') as string || rule.ruleType
  const ruleMode = formData.get('ruleMode') as string || rule.ruleMode
  const value = formData.get('value') as string
  const priority = parseInt(formData.get('priority') as string) || rule.priority
  const isActive = formData.get('isActive') === 'on'
  const businessId = formData.get('businessId') as string
  const region = formData.get('region') as string
  const country = formData.get('country') as string
  const packageId = formData.get('packageId') as string
  const packageType = formData.get('packageType') as string
  const startDate = formData.get('startDate') as string
  const endDate = formData.get('endDate') as string

  const data: any = {
    name,
    description: description || null,
    ruleType,
    ruleMode,
    priority,
    isActive,
  }

  if (value) data.value = parseFloat(value)
  else data.value = rule.value

  data.businessId = businessId || null
  data.region = region || null
  data.country = country || null
  data.packageId = packageId || null
  data.packageType = packageType || null
  data.startDate = startDate ? new Date(startDate) : rule.startDate
  data.endDate = endDate ? new Date(endDate) : rule.endDate

  try {
    await prisma.pricingRule.update({ where: { id: ruleId }, data })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'UPDATE', entity: 'PricingRule', entityId: ruleId, details: `Updated pricing rule: ${name}` },
    })
    revalidatePath('/admin/pricing-rules')
    redirect('/admin/pricing-rules?success=Rule+updated')
  } catch (error: any) {
    redirect(`/admin/pricing-rules/${ruleId}/edit?error=${encodeURIComponent(error.message || 'Failed to update rule')}`)
  }
}

export async function togglePricingRule(ruleId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const rule = await prisma.pricingRule.findUnique({ where: { id: ruleId } })
  if (!rule) redirect('/admin/pricing-rules?error=Rule+not+found')

  const newActive = formData.get('isActive') === 'on'

  try {
    await prisma.pricingRule.update({ where: { id: ruleId }, data: { isActive: newActive } })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: newActive ? 'ACTIVATE' : 'DEACTIVATE', entity: 'PricingRule', entityId: ruleId, details: `${newActive ? 'Activated' : 'Deactivated'} pricing rule: ${rule.name}` },
    })
    revalidatePath('/admin/pricing-rules')
    redirect(`/admin/pricing-rules?success=Rule+${newActive ? 'activated' : 'deactivated'}`)
  } catch (error: any) {
    redirect(`/admin/pricing-rules?error=${encodeURIComponent(error.message || 'Failed to toggle rule')}`)
  }
}
