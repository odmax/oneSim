'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'

export async function generateUsageReport() {
  const session = await getServerSession(authOptions)
  
  if (!session) {
    redirect('/login')
  }

  if (!['BUSINESS_USER', 'INTERNAL_ADMIN'].includes(session.user.role)) {
    redirect('/login')
  }

  try {
    const where: any = {}
    if (session.user.role === 'BUSINESS_USER' && session.user.businessId) {
      where.purchase = { businessId: session.user.businessId }
    }

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'SYNC',
        entity: 'UsageRecord',
        entityId: 'bulk',
        details: `Usage report generated`,
      },
    })

    if (session.user.role === 'BUSINESS_USER') {
      redirect('/business/usage')
    } else {
      redirect('/admin/usage')
    }
  } catch (error) {
    console.error('Usage sync error:', error)
    if (session.user.role === 'BUSINESS_USER') {
      redirect('/business/usage')
    } else {
      redirect('/admin/usage')
    }
  }
}
