'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { registry } from '@/services/providerRegistry'
import { sendEmail } from '@/lib/email/send-email'
import { getAppBaseUrl } from '@/lib/config/app-url'
import { buildESIMInstallEmail } from '@/lib/email/esim-share-email'
import crypto from 'crypto'

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
    } catch { }
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
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId! },
    select: { role: true },
  })
  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string
  const customerId = formData.get('customerId') as string

  if (!esimId) {
    console.error('[assignESIM] Missing esimId')
    redirect('/business/esims?error=assignment_failed')
  }
  if (!customerId) {
    console.error('[assignESIM] Missing customerId for esim:', esimId)
    redirect('/business/esims?error=assignment_failed')
  }

  try {
    const esim = await prisma.eSIM.findFirst({
      where: { id: esimId, purchase: { businessId: session.user.businessId! } },
      include: { purchase: { include: { package: true } } },
    })
    if (!esim) {
      console.error('[assignESIM] eSIM not found or wrong business:', esimId, 'business:', session.user.businessId)
      redirect('/business/esims?error=assignment_failed')
    }

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId: session.user.businessId! },
    })
    if (!customer) {
      console.error('[assignESIM] Customer not found or wrong business:', customerId)
      redirect('/business/esims?error=assignment_failed')
    }

    await prisma.eSIM.update({
      where: { id: esimId },
      data: { customerId },
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'ASSIGN',
        entity: 'ESIM',
        entityId: esimId,
        details: `Assigned eSIM to customer: ${customer.name} (${customer.email})`,
      },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect('/business/esims?success=assigned')
  } catch (error: any) {
    console.error('[assignESIM] Error:', error?.message || error)
    redirect('/business/esims?error=assignment_failed')
  }
}

export async function unassignESIM(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId! },
    select: { role: true },
  })
  if (!businessUser || businessUser.role !== 'ADMIN') {
    redirect('/business/esims?error=permission')
  }

  const esimId = formData.get('esimId') as string
  if (!esimId) { redirect('/business/esims?error=assignment_failed') }

  try {
    const esim = await prisma.eSIM.findFirst({
      where: { id: esimId, purchase: { businessId: session.user.businessId! } },
      include: { customer: true },
    })
    if (!esim) {
      console.error('[unassignESIM] eSIM not found:', esimId)
      redirect('/business/esims?error=assignment_failed')
    }

    const customerName = esim.customer?.name || 'Unknown'
    await prisma.eSIM.update({ where: { id: esimId }, data: { customerId: null } })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'UNASSIGN', entity: 'ESIM', entityId: esimId, details: `Unassigned eSIM from customer: ${customerName}` },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect('/business/esims?success=unassigned')
  } catch (error: any) {
    console.error('[unassignESIM] Error:', error?.message || error)
    redirect('/business/esims?error=assignment_failed')
  }
}

export async function markAsSent(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }
  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId! },
    select: { role: true },
  })
  if (!businessUser || businessUser.role !== 'ADMIN') { redirect('/business/esims?error=permission') }
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
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId! },
    select: { role: true },
  })
  if (!businessUser || businessUser.role !== 'ADMIN') { redirect('/business/esims?error=permission') }

  const esimId = formData.get('esimId') as string
  const redirectTo = (formData.get('redirectTo') as string) || '/business/esims'
  if (!esimId) { redirect(`${redirectTo}?error=assignment_failed`) }

  try {
    const esim = await prisma.eSIM.findFirst({
      where: { id: esimId, purchase: { businessId: session.user.businessId! } },
      include: { customer: true, purchase: { include: { package: true } } },
    })
    if (!esim || !esim.customerId || !esim.customer) { redirect(`${redirectTo}?error=assignment_failed`) }

    await prisma.eSIM.update({
      where: { id: esimId },
      data: { deliveryStatus: 'SENT', deliveredAt: new Date() },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'DELIVER', entity: 'ESIM', entityId: esimId, details: `Sent activation to customer: ${esim.customer.name} (${esim.customer.email})` },
    })

    revalidatePath('/business/esims')
    revalidatePath('/business/customers')
    redirect(`${redirectTo}?success=sent`)
  } catch (error: any) {
    console.error('[sendToCustomer] Error:', error?.message || error)
    redirect(`${redirectTo}?error=assignment_failed`)
  }
}

export async function syncEsimStatusAction(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session) { redirect('/login') }

  const isAdmin = session.user.role === 'INTERNAL_ADMIN'

  if (!isAdmin) {
    const esim = await prisma.eSIM.findFirst({
      where: { id: esimId, purchase: { businessId: session.user.businessId! } },
    })
    if (!esim) { redirect('/business/esims?error=permission') }
  }

  const { syncESIMStatus } = await import('@/lib/services/esims/sync-esim-status')
  const result = await syncESIMStatus(esimId)

  revalidatePath(`/admin/esims/${esimId}`)
  revalidatePath('/admin/esims')
  revalidatePath('/business/esims')

  const basePath = isAdmin ? `/admin/esims/${esimId}` : '/business/esims'
  if (result.success) {
    if (result.activated) redirect(`${basePath}?success=activated`)
    redirect(`${basePath}?success=refreshed`)
  } else {
    redirect(`${basePath}?error=${encodeURIComponent(result.error || 'sync_failed')}`)
  }
}

export async function shareEsimViaEmail(esimId: string, recipientEmail: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') { return { success: false, error: 'Not authorized' } }

  const esim = await prisma.eSIM.findFirst({
    where: { id: esimId, purchase: { businessId: session.user.businessId! } },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const pkg = esim.purchase.package
  const installLink = `${getAppBaseUrl()}/install/esim/${esim.id}`

  const emailContent = buildESIMInstallEmail({
    recipientName: recipientEmail.split('@')[0] || 'Customer',
    packageName: pkg.displayName || pkg.name,
    iccid: esim.iccid,
    activationCode: esim.activationCode || undefined,
    qrCodeUrl: esim.qrCodeUrl || undefined,
    installLink,
    validityDays: pkg.validityDays,
  })

  const emailResult = await sendEmail({
    to: recipientEmail,
    subject: `Your eSIM from OneSim Africa is ready to install`,
    html: emailContent.html,
  })

  if (!emailResult.success) return { success: false, error: emailResult.error }

  await prisma.eSIM.update({
    where: { id: esimId },
    data: { sharedAt: new Date(), sharedToEmail: recipientEmail },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'SHARE_EMAIL', entity: 'ESIM', entityId: esimId, details: `Shared eSIM via email to ${recipientEmail}` },
  })

  revalidatePath('/business/esims')
  return { success: true }
}

export async function createShareToken(esimId: string): Promise<{ success: boolean; token?: string; url?: string; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session) return { success: false, error: 'Not authenticated' }

  const isAdmin = session.user.role === 'INTERNAL_ADMIN'
  if (!isAdmin && session.user.role !== 'BUSINESS_USER') return { success: false, error: 'Not authorized' }

  const where: any = { id: esimId }
  if (!isAdmin) where.purchase = { businessId: session.user.businessId! }

  const esim = await prisma.eSIM.findFirst({ where })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const token = crypto.randomBytes(32).toString('hex')
  await prisma.eSIMShareToken.create({
    data: {
      esimId,
      token,
      createdById: session.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  })

  const url = `${getAppBaseUrl()}/install/esim/${token}`
  return { success: true, token, url }
}