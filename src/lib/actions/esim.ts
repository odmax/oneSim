'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { registry } from '@/services/providerRegistry'

export async function suspendESIM(esimId: string) {
  await prisma.eSIM.update({
    where: { id: esimId },
    data: { status: 'SUSPENDED' },
  })

  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (esim) {
    try {
      const slug = esim.purchase?.package?.providerName?.toLowerCase()
      if (slug) {
        const adapter = await registry.resolve(slug)
        await adapter.deactivate(esim.iccid)
      }
    } catch {
      // Provider not in registry — rely on DB status change
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'SUSPEND',
      entity: 'ESIM',
      entityId: esimId,
      details: `Suspended eSIM`,
    },
  })

  revalidatePath('/admin/esims')
  revalidatePath('/business/esims')
}

export async function assignESIM(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Check if user is admin
  const businessUser = await prisma.businessUser.findFirst({
    where: { 
      userId: session.user.id,
      businessId: session.user.businessId!
    },
    select: { role: true }
  })

  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string
  const customerId = formData.get('customerId') as string

  if (!esimId || !customerId) {
    redirect('/business/esims?error=assignment_failed')
  }

  try {
    // Verify eSIM belongs to business and customer belongs to same business
    const esim = await prisma.eSIM.findFirst({
      where: {
        id: esimId,
        purchase: { businessId: session.user.businessId! }
      },
      include: {
        purchase: { include: { package: true } }
      }
    })

    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        businessId: session.user.businessId!
      }
    })

    if (!esim || !customer) {
      redirect('/business/esims?error=assignment_failed')
    }

    await prisma.eSIM.update({
      where: { id: esimId },
      data: { customerId }
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'ASSIGN',
        entity: 'ESIM',
        entityId: esimId,
        details: `Assigned eSIM to customer: ${customer.name}`,
      },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect('/business/esims?success=assigned')
  } catch (error) {
    redirect('/business/esims?error=assignment_failed')
  }
}

export async function unassignESIM(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Check if user is admin
  const businessUser = await prisma.businessUser.findFirst({
    where: { 
      userId: session.user.id,
      businessId: session.user.businessId!
    },
    select: { role: true }
  })

  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string

  if (!esimId) {
    redirect('/business/esims?error=assignment_failed')
  }

  try {
    // Verify eSIM belongs to business
    const esim = await prisma.eSIM.findFirst({
      where: {
        id: esimId,
        purchase: { businessId: session.user.businessId! }
      },
      include: { customer: true }
    })

    if (!esim) {
      redirect('/business/esims?error=assignment_failed')
    }

    const customerName = esim.customer?.name || 'Unknown'

    await prisma.eSIM.update({
      where: { id: esimId },
      data: { customerId: null }
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'UNASSIGN',
        entity: 'ESIM',
        entityId: esimId,
        details: `Unassigned eSIM from customer: ${customerName}`,
      },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect('/business/esims?success=unassigned')
  } catch (error) {
    redirect('/business/esims?error=assignment_failed')
  }
}

export async function markAsSent(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Check if user is admin
  const businessUser = await prisma.businessUser.findFirst({
    where: { 
      userId: session.user.id,
      businessId: session.user.businessId!
    },
    select: { role: true }
  })

  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string
  const redirectTo = formData.get('redirectTo') as string || '/business/esims'

  if (!esimId) {
    redirect(`${redirectTo}?error=assignment_failed`)
  }
}

export async function syncSubscriptionStatus(esimId: string) {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { error: 'eSIM not found' }
  if (!esim.providerActivationId) return { error: 'No provider activation ID' }

  try {
    const slug = esim.purchase?.package?.providerName?.toLowerCase()
    if (!slug) return { error: 'No provider slug found' }

    const adapter = await registry.resolve(slug)
    const status = await adapter.getStatus(esim.iccid)

    await prisma.eSIM.update({
      where: { id: esimId },
      data: { providerStatus: status.status, status: status.status === 'ACTIVE' ? 'ACTIVE' : esim.status },
    })

    return { status: status.status }
  } catch (e: any) {
    return { error: e.message || 'Sync failed' }
  }
}

export async function sendToCustomer(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Check if user is admin
  const businessUser = await prisma.businessUser.findFirst({
    where: { 
      userId: session.user.id,
      businessId: session.user.businessId!
    },
    select: { role: true }
  })

  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string
  const redirectTo = formData.get('redirectTo') as string || '/business/esims'

  if (!esimId) {
    redirect(`${redirectTo}?error=assignment_failed`)
  }

  try {
    // Verify eSIM belongs to business and has customer assigned
    const esim = await prisma.eSIM.findFirst({
      where: {
        id: esimId,
        purchase: { businessId: session.user.businessId! }
      },
      include: { 
        customer: true,
        purchase: {
          include: { package: true }
        }
      }
    })

    if (!esim || !esim.customerId || !esim.customer) {
      redirect(`${redirectTo}?error=assignment_failed`)
    }

    // Mark as sent
    await prisma.eSIM.update({
      where: { id: esimId },
      data: { 
        deliveryStatus: 'SENT',
        deliveredAt: new Date()
      }
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'DELIVER',
        entity: 'ESIM',
        entityId: esimId,
        details: `Sent activation details to customer: ${esim.customer.name} (${esim.customer.email})`,
      },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect(`${redirectTo}?success=sent`)
  } catch (error) {
    redirect(`${redirectTo}?error=assignment_failed`)
  }
}
