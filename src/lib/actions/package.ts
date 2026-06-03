'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function createPackage(formData: FormData) {
  const name = formData.get('name') as string
  const description = formData.get('description') as string
  const dataGB = parseInt(formData.get('dataGB') as string)
  const validityDays = parseInt(formData.get('validityDays') as string)
  const priceUSD = parseFloat(formData.get('priceUSD') as string)
  const localPrice = parseFloat(formData.get('localPrice') as string)
  const currency = formData.get('currency') as string || 'USD'

  await prisma.eSIMPackage.create({
    data: {
      name,
      description,
      dataGB,
      validityDays,
      priceUSD,
      localPrice,
      currency,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'CREATE',
      entity: 'ESIMPackage',
      details: `Created package: ${name}`,
    },
  })

  revalidatePath('/admin/packages')
}

export async function updatePackage(formData: FormData) {
  const id = formData.get('id') as string
  const name = formData.get('name') as string
  const description = formData.get('description') as string
  const dataGB = parseInt(formData.get('dataGB') as string)
  const validityDays = parseInt(formData.get('validityDays') as string)
  const priceUSD = parseFloat(formData.get('priceUSD') as string)
  const localPrice = parseFloat(formData.get('localPrice') as string)
  const isActive = formData.get('isActive') === 'true'

  await prisma.eSIMPackage.update({
    where: { id },
    data: {
      name,
      description,
      dataGB,
      validityDays,
      priceUSD,
      localPrice,
      isActive,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'UPDATE',
      entity: 'ESIMPackage',
      entityId: id,
      details: `Updated package: ${name}`,
    },
  })

  revalidatePath('/admin/packages')
}

export async function deletePackageAction(formData: FormData) {
  const id = formData.get('id') as string
  if (!id) return

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id },
    include: { _count: { select: { purchases: true, topUpRecords: true } } },
  })
  if (!pkg) return

  const esimCount = await prisma.eSIM.count({
    where: { purchase: { packageId: id } },
  })
  const hasDependents = pkg._count.purchases > 0 || pkg._count.topUpRecords > 0 || esimCount > 0

  if (hasDependents) {
    await prisma.eSIMPackage.update({
      where: { id },
      data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'ARCHIVE',
        entity: 'ESIMPackage',
        entityId: id,
        details: `Archived package (had ${pkg._count.purchases} purchases, ${pkg._count.topUpRecords} top-ups): ${pkg.name}. Existing eSIMs and orders preserved.`,
      },
    })
  } else {
    try {
      await prisma.eSIMPackage.delete({ where: { id } })

      await prisma.auditLog.create({
        data: {
          action: 'DELETE',
          entity: 'ESIMPackage',
          entityId: id,
          details: `Deleted package (no purchases or top-ups): ${pkg.name}`,
        },
      })
    } catch (err: any) {
      // P2003 = foreign key constraint violation — dependent records found at DB level
      if (err.code === 'P2003') {
        await prisma.eSIMPackage.update({
          where: { id },
          data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() },
        })
        await prisma.auditLog.create({
          data: {
            action: 'ARCHIVE',
            entity: 'ESIMPackage',
            entityId: id,
            details: `Archived package (protected by DB constraint): ${pkg.name}. Existing eSIMs preserved.`,
          },
        })
      } else {
        throw err
      }
    }
  }

  revalidatePath('/admin/packages')
  revalidatePath('/admin/providers')
}
