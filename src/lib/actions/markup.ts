'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'

export async function togglePackageActivation(packageId: string, formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: packageId },
  })

  if (!pkg) {
    redirect(`/admin/packages?error=${encodeURIComponent('Package not found.')}`)
  }

  const newActive = formData.get('isActive') === 'on'

  if (newActive) {
    if (parseFloat(pkg.priceUSD.toString()) <= 0) {
      redirect(`/admin/packages?error=${encodeURIComponent('Selling price must be greater than 0 before activation.')}`)
    }

    if (pkg.providerName && !pkg.providerPlanId) {
      redirect(`/admin/packages?error=${encodeURIComponent('Imported provider package must have a providerPlanId.')}`)
    }
  }

  await prisma.eSIMPackage.update({
    where: { id: packageId },
    data: {
      isActive: newActive,
      // When reactivating, clear archive/hidden flags so package re-appears in catalog
      ...(newActive ? { hiddenFromCatalog: false, archivedAt: null } : {}),
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: newActive ? 'ACTIVATE' : 'DEACTIVATE',
      entity: 'ESIMPackage',
      entityId: packageId,
      details: `${newActive ? 'Activated' : 'Deactivated'} package: ${pkg.name}`,
    },
  })

  revalidatePath('/admin/packages')
  redirect(`/admin/packages?success=${encodeURIComponent(`Package "${pkg.name}" ${newActive ? 'activated' : 'deactivated'}.`)}`)
}

export async function hidePackageFromClients(packageId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
  if (!pkg) redirect('/admin/packages?error=Package+not+found')

  await prisma.eSIMPackage.update({
    where: { id: packageId },
    data: { isActive: false },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PACKAGE_HIDDEN_FROM_CLIENTS',
      entity: 'ESIMPackage',
      entityId: packageId,
      details: `Hidden from clients: ${pkg.name}`,
    },
  })

  revalidatePath('/admin/packages')
  redirect(`/admin/packages?success=${encodeURIComponent(`Package "${pkg.name}" hidden from clients.`)}`)
}

export async function movePackageToProviderPlan(packageId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
  if (!pkg) redirect('/admin/packages?error=Package+not+found')

  await prisma.eSIMPackage.update({
    where: { id: packageId },
    data: { source: 'PROVIDER_PLAN', isActive: false },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PACKAGE_MOVED_TO_PROVIDER_PLAN',
      entity: 'ESIMPackage',
      entityId: packageId,
      details: `Moved back to provider plans: ${pkg.name}`,
    },
  })

  revalidatePath('/admin/packages')
  redirect(`/admin/packages?tab=provider&success=${encodeURIComponent(`Package "${pkg.name}" moved back to provider plans.`)}`)
}

export async function updatePackagePrice(packageId: string, formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const priceUSD = formData.get('priceUSD') as string
  const localPrice = formData.get('localPrice') as string
  const displayName = formData.get('displayName') as string
  const customerDescription = formData.get('customerDescription') as string
  const providerId = formData.get('providerId') as string
  const providerPlanId = formData.get('providerPlanId') as string
  const isActive = formData.get('isActive') === 'on'

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: packageId },
  })

  if (!pkg) {
    redirect(`/admin/packages?error=${encodeURIComponent('Package not found.')}`)
  }

  const newPriceUSD = parseFloat(priceUSD) || 0
  const newLocalPrice = parseFloat(localPrice) || 0

  if (isActive && newPriceUSD <= 0) {
    redirect(`/admin/packages/${packageId}/edit?error=${encodeURIComponent('Selling price must be greater than 0 before activation.')}`)
  }

  const costPriceUSD = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
  const markupPercent = costPriceUSD > 0
    ? Math.round(((newPriceUSD - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
    : undefined

  const updateData: any = {
    priceUSD: newPriceUSD,
    localPrice: newLocalPrice,
    isActive,
    displayName: displayName || null,
    customerDescription: customerDescription || null,
    markupPercent,
  }

  if (providerId !== undefined) {
    updateData.providerId = providerId || null
  }
  if (providerPlanId !== undefined) {
    updateData.providerPlanId = providerPlanId || null
  }
  if (pkg.providerName && providerPlanId && providerPlanId !== pkg.providerPlanId) {
    updateData.providerName = pkg.providerName
  }

  await prisma.eSIMPackage.update({
    where: { id: packageId },
    data: updateData,
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'UPDATE',
      entity: 'ESIMPackage',
      entityId: packageId,
      details: `Updated package ${pkg.name}: price $${newPriceUSD}, active=${isActive}${providerId ? ', provider linked' : ''}`,
    },
  })

  revalidatePath('/admin/packages')
  redirect(`/admin/packages?success=${encodeURIComponent(`Package "${pkg.name}" updated.`)}`)
}

import { suggestDisplayName } from '@/lib/packages/package-utils'

export async function savePackage(packageId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const action = formData.get('__action') as string
  const displayName = formData.get('displayName') as string
  const customerDescription = formData.get('customerDescription') as string
  const priceUSD = formData.get('priceUSD') as string
  const localPrice = formData.get('localPrice') as string
  const providerId = formData.get('providerId') as string
  const providerPlanId = formData.get('providerPlanId') as string
  const isActive = formData.get('isActive') === 'on'

  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
  if (!pkg) redirect('/admin/packages?error=Package+not+found')

  const newPriceUSD = parseFloat(priceUSD) || 0
  const newLocalPrice = parseFloat(localPrice) || 0

  if (newPriceUSD <= 0) {
    redirect(`/admin/packages/${packageId}/edit?error=${encodeURIComponent('Selling price must be greater than 0.')}`)
  }

  const costPriceUSD = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
  const markupPercent = costPriceUSD > 0
    ? Math.round(((newPriceUSD - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
    : undefined

  let finalIsActive = pkg.isActive
  let auditAction = 'UPDATE'
  let auditDetail = `Updated package ${pkg.name}: $${newPriceUSD}, active=${finalIsActive}`
  let redirectTab = pkg.source === 'PROVIDER_PLAN' ? 'provider' : ''

  const updateData: any = {}

  if (action === 'save_and_activate') {
    finalIsActive = true
    updateData.isActive = true
    updateData.hiddenFromCatalog = false
    updateData.archivedAt = null
  } else if (action === 'hide') {
    finalIsActive = false
    updateData.isActive = false
    auditAction = 'PACKAGE_HIDDEN_FROM_CLIENTS'
    auditDetail = `Hidden from clients: ${pkg.name}`
  } else if (action === 'move_to_provider') {
    finalIsActive = false
    updateData.source = 'PROVIDER_PLAN'
    updateData.isActive = false
    auditAction = 'PACKAGE_MOVED_TO_PROVIDER_PLAN'
    auditDetail = `Moved back to provider plans: ${pkg.name}`
    redirectTab = 'provider'
  } else if (action === 'save_and_convert') {
    finalIsActive = isActive
    updateData.source = 'CATALOG_PRODUCT'
    updateData.isActive = finalIsActive
    updateData.displayName = displayName || pkg.displayName || suggestDisplayName?.(pkg) || pkg.name
    updateData.customerDescription = customerDescription || null
    updateData.priceUSD = newPriceUSD
    updateData.localPrice = newLocalPrice
    updateData.markupPercent = markupPercent
    auditAction = 'CONVERT_TO_CATALOG'
    auditDetail = `Converted to catalog product: ${displayName || pkg.name} at $${newPriceUSD}`
    redirectTab = 'catalog'
  } else {
    finalIsActive = pkg.isActive
    updateData.displayName = displayName || pkg.displayName || null
    updateData.customerDescription = customerDescription || null
    updateData.priceUSD = newPriceUSD
    updateData.localPrice = newLocalPrice
    updateData.markupPercent = markupPercent
  }

  if (providerId !== undefined) updateData.providerId = providerId || null
  if (providerPlanId !== undefined) updateData.providerPlanId = providerPlanId || null
  if (pkg.providerName && providerPlanId && providerPlanId !== pkg.providerPlanId) {
    updateData.providerName = pkg.providerName
  }

  await prisma.eSIMPackage.update({ where: { id: packageId }, data: updateData })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: auditAction,
      entity: 'ESIMPackage',
      entityId: packageId,
      details: auditDetail,
    },
  })

  revalidatePath('/admin/packages')
  revalidatePath('/admin/provider-plans')
  revalidatePath('/admin/catalog-products')
  const basePath = redirectTab ? `/admin/packages?tab=${redirectTab}` : '/admin/packages'
  const sep = basePath.includes('?') ? '&' : '?'
  redirect(`${basePath}${sep}success=${encodeURIComponent(`Package "${pkg.name}" saved.${finalIsActive ? ' Active for clients.' : ''}`)}`)
}

// bulkApplyMarkup — removed; pricing is manual per product
