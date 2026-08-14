import { prisma } from '@/lib/prisma'
import { InternalAdminRole } from '@prisma/client'

export async function auditLog(data: {
  userId?: string
  action: string
  entity: string
  entityId?: string
  details?: string
}) {
  try {
    await prisma.auditLog.create({ data: { userId: data.userId || null, action: data.action, entity: data.entity, entityId: data.entityId || null, details: data.details || null } })
  } catch (e) {
    console.error('audit log failed (non-fatal):', e)
  }
}

export async function countSuperAdmins(): Promise<number> {
  return prisma.internalAdmin.count({ where: { role: 'SUPER_ADMIN', isActive: true } })
}

export async function isLastSuperAdmin(userId: string): Promise<boolean> {
  const admin = await prisma.internalAdmin.findUnique({ where: { userId } })
  if (!admin || admin.role !== 'SUPER_ADMIN') return false
  const count = await countSuperAdmins()
  return count <= 1
}

export async function checkProviderSafeToDeactivate(providerId: string): Promise<{ safe: boolean; reason?: string }> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { safe: false, reason: 'Provider not found' }

  if (provider.isDefaultFallback) {
    const fallbackCount = await prisma.provider.count({ where: { isDefaultFallback: true } })
    if (fallbackCount <= 1) return { safe: false, reason: 'This is the only default fallback provider. Set another provider as fallback first.' }
  }

  return { safe: true }
}

export async function checkProviderCertifiedForLive(providerId: string): Promise<{ allowed: boolean; reason?: string }> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { certificationStatus: true, status: true } })
  if (!provider) return { allowed: false, reason: 'Provider not found' }

  if (provider.status === 'ACTIVE' && provider.certificationStatus !== 'CERTIFIED') {
    return { allowed: false, reason: 'Provider must be CERTIFIED before setting status to ACTIVE. Current status: ' + (provider.certificationStatus || 'CONFIGURING') }
  }

  return { allowed: true }
}

export async function checkRefundSafe(orderId: string): Promise<{ safe: boolean; reason?: string }> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    select: { id: true },
  })
  if (!order) return { safe: false, reason: 'Order not found' }

  const captured = await prisma.walletTransaction.findFirst({
    where: { orderId, type: 'WALLET_CAPTURE' },
  })

  if (!captured) {
    return { safe: false, reason: 'No captured payment to refund. Only captured orders can be refunded.' }
  }

  return { safe: true }
}
