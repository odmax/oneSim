'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { suggestDisplayName } from '@/lib/packages/package-utils'

export async function convertToCatalogProduct(packageId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const priceUSD = formData.get('priceUSD') as string
  const localPrice = formData.get('localPrice') as string
  const isActive = formData.get('isActive') === 'on'

  if (!priceUSD || parseFloat(priceUSD) <= 0) {
    redirect(`/admin/provider-plans/${packageId}/convert?error=Price+must+be+greater+than+0`)
  }

  try {
    const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
    if (!pkg) redirect('/admin/provider-plans?error=Package+not+found')
    if (pkg.source !== 'PROVIDER_PLAN') redirect(`/admin/provider-plans/${packageId}/convert?error=Only+provider+plans+can+be+converted`)

    const displayName = pkg.displayName || suggestDisplayName(pkg)
    const newPriceUSD = parseFloat(priceUSD)
    const costPriceUSD = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
    const markupPercent = costPriceUSD > 0
      ? Math.round(((newPriceUSD - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
      : undefined

    await prisma.eSIMPackage.update({
      where: { id: packageId },
      data: {
        source: 'CATALOG_PRODUCT',
        priceUSD: newPriceUSD,
        localPrice: localPrice ? parseFloat(localPrice) : newPriceUSD,
        isActive,
        displayName,
        markupPercent,
      },
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'CONVERT_TO_CATALOG',
        entity: 'ESIMPackage',
        entityId: packageId,
        details: `Converted provider plan to catalog product: ${pkg.name} at $${priceUSD}`,
      },
    })

    revalidatePath('/admin/provider-plans')
    revalidatePath('/admin/catalog-products')
    revalidatePath('/admin/packages')
    redirect(`/admin/packages?tab=catalog&success=${encodeURIComponent('Package converted to catalog product')}`)
  } catch (error: any) {
    redirect(`/admin/packages/${packageId}/edit?error=${encodeURIComponent(error.message || 'Conversion failed')}`)
  }
}

export async function saveAndConvertToCatalog(packageId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const displayName = formData.get('displayName') as string
  const customerDescription = formData.get('customerDescription') as string
  const priceUSD = formData.get('priceUSD') as string
  const localPrice = formData.get('localPrice') as string
  const providerId = formData.get('providerId') as string
  const providerPlanId = formData.get('providerPlanId') as string
  const isActive = formData.get('isActive') === 'on'

  if (!priceUSD || parseFloat(priceUSD) <= 0) {
    redirect(`/admin/packages/${packageId}/edit?error=${encodeURIComponent('Selling price must be greater than 0.')}`)
  }

  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
  if (!pkg) redirect('/admin/packages?error=Package+not+found')

  const newPriceUSD = parseFloat(priceUSD)
  const costPriceUSD = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
  const markupPercent = costPriceUSD > 0
    ? Math.round(((newPriceUSD - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
    : undefined

  const updateData: any = {
    source: 'CATALOG_PRODUCT',
    displayName: displayName || pkg.displayName || suggestDisplayName(pkg),
    customerDescription: customerDescription || null,
    priceUSD: newPriceUSD,
    localPrice: localPrice ? parseFloat(localPrice) : newPriceUSD,
    isActive,
    markupPercent,
  }

  if (providerId !== undefined) {
    updateData.providerId = providerId || null
  }
  if (providerPlanId !== undefined) {
    updateData.providerPlanId = providerPlanId || null
  }

  await prisma.eSIMPackage.update({
    where: { id: packageId },
    data: updateData,
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'CONVERT_TO_CATALOG',
      entity: 'ESIMPackage',
      entityId: packageId,
      details: `Configured and converted to catalog product: ${displayName || pkg.name} at $${priceUSD}`,
    },
  })

  revalidatePath('/admin/packages')
  revalidatePath('/admin/provider-plans')
  revalidatePath('/admin/catalog-products')
  redirect(`/admin/packages?tab=catalog&success=${encodeURIComponent(`Package converted to catalog product.${isActive ? ' Activated for clients.' : ''}`)}`)
}

export async function bulkConvertToCatalog(packageIds: string[], formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  let count = 0
  for (const id of packageIds) {
    const pkg = await prisma.eSIMPackage.findUnique({ where: { id } })
    if (pkg && pkg.source === 'PROVIDER_PLAN') {
      const costPriceUSD = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
      const newPriceUSD = parseFloat(pkg.priceUSD.toString())
      const markupPercent = costPriceUSD > 0 && newPriceUSD > 0
        ? Math.round(((newPriceUSD - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
        : undefined

      await prisma.eSIMPackage.update({
        where: { id },
        data: {
          source: 'CATALOG_PRODUCT',
          displayName: pkg.displayName || suggestDisplayName(pkg),
          markupPercent,
        },
      })
      count++
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'BULK_CONVERT_TO_CATALOG',
      entity: 'ESIMPackage',
      entityId: packageIds.join(','),
      details: `Bulk converted ${count} provider plans to catalog products`,
    },
  })

  revalidatePath('/admin/provider-plans')
  revalidatePath('/admin/catalog-products')
  revalidatePath('/admin/packages')
  redirect(`/admin/packages?tab=provider&success=${encodeURIComponent(`Converted ${count} plans to catalog products`)}`)
}
