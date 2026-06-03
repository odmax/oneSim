'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { authOptions } from '@/lib/auth/config'
import { getServerSession } from 'next-auth'

export async function updateBusiness(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session) {
    redirect('/login')
  }

  const businessId = formData.get('businessId') as string
  const name = formData.get('name') as string
  const regNumber = formData.get('regNumber') as string
  const taxId = formData.get('taxId') as string
  const contactEmail = formData.get('contactEmail') as string
  const contactPhone = formData.get('contactPhone') as string
  const country = formData.get('country') as string
  const address = formData.get('address') as string
  const status = formData.get('status') as string

  if (!businessId || !name || !contactEmail || !country) {
    redirect('/admin/businesses?error=missing_required')
  }

  try {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        name,
        regNumber: regNumber || null,
        taxId: taxId || null,
        contactEmail,
        contactPhone: contactPhone || null,
        country,
        address: address || null,
        ...(status && ['PENDING', 'APPROVED', 'SUSPENDED'].includes(status) ? { status: status as any } : {}),
      },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'UPDATE', entity: 'Business', entityId: businessId, details: `Updated business profile${status ? ` (status: ${status})` : ''}` },
    })

    revalidatePath('/admin/businesses')
    revalidatePath(`/admin/businesses/${businessId}`)
    redirect(`/admin/businesses/${businessId}?success=updated`)
  } catch (error) {
    console.error('Business update error:', error)
    redirect(`/admin/businesses/${businessId}/edit?error=update_failed`)
  }
}

export async function updateBusinessStatus(businessId: string, status: string) {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')

  try {
    await prisma.business.update({ where: { id: businessId }, data: { status: status as any } })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: status === 'APPROVED' ? 'APPROVE' : 'SUSPEND', entity: 'Business', entityId: businessId, details: `Business status changed to ${status}` },
    })
    revalidatePath('/admin/businesses')
    revalidatePath(`/admin/businesses/${businessId}`)
    redirect('/admin/businesses?success=status_updated')
  } catch (error) {
    console.error('Status update error:', error)
    redirect('/admin/businesses?error=status_update_failed')
  }
}

export async function createBusiness(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  const regNumber = formData.get('regNumber') as string
  const taxId = formData.get('taxId') as string
  const contactEmail = formData.get('contactEmail') as string
  const contactPhone = formData.get('contactPhone') as string
  const country = formData.get('country') as string
  const address = formData.get('address') as string;
  const adminName = formData.get('adminName') as string
  const adminEmail = formData.get('adminEmail') as string
  const adminPassword = formData.get('adminPassword') as string
  const status = formData.get('status') as string || 'PENDING';

  if (!name || !contactEmail || !country) redirect('/admin/businesses/new?error=missing_business_info')
  if (!adminName || !adminEmail) redirect('/admin/businesses/new?error=missing_admin_info')
  if (!adminPassword || adminPassword.length < 8) redirect('/admin/businesses/new?error=password_too_short')

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } })
    if (existingUser) redirect('/admin/businesses/new?error=email_exists')

    const passwordHash = await bcrypt.hash(adminPassword, 10)

    await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: { name, regNumber: regNumber || null, taxId: taxId || null, contactEmail, contactPhone: contactPhone || null, country, address: address || null, status: status as any, walletBalance: 0 },
      })

      const user = await tx.user.create({
        data: { email: adminEmail, passwordHash, name: adminName, role: 'BUSINESS_USER', isActive: true },
      })

      await tx.businessUser.create({ data: { userId: user.id, businessId: business.id, role: 'ADMIN' } })
      await tx.auditLog.create({
        data: { userId: session.user.id, action: 'CREATE', entity: 'Business', entityId: business.id, details: `Created business: ${name} with admin: ${adminEmail}` },
      })
    })

    revalidatePath('/admin/businesses')
    redirect(`/admin/businesses/new?success=true&email=${encodeURIComponent(adminEmail)}&password=${encodeURIComponent(adminPassword)}`)
  } catch (error: any) {
    console.error('Business creation error:', error)
    if (error?.code === 'P2002') redirect('/admin/businesses/new?error=email_exists')
    redirect('/admin/businesses/new?error=creation_failed')
  }
}

export async function deleteBusiness(businessId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const admin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!admin || admin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) redirect('/admin/businesses?error=Business+not+found')

  await prisma.business.delete({ where: { id: businessId } })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'DELETE', entity: 'Business', entityId: businessId, details: `Deleted business: ${business.name}` },
  })

  revalidatePath('/admin/businesses')
  redirect('/admin/businesses?success=business_deleted')
}
