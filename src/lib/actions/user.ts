'use server'

import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

export async function addTeamMember(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  const userId = session.user.id
  const businessId = formData.get('businessId') as string
  const name = formData.get('name') as string
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const role = formData.get('role') as 'ADMIN' | 'MEMBER'

  const passwordHash = await bcrypt.hash(password, 10)

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role: 'BUSINESS_USER',
    },
  })

  await prisma.businessUser.create({
    data: {
      userId: user.id,
      businessId,
      role,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId,
      action: 'CREATE',
      entity: 'BusinessUser',
      entityId: user.id,
      details: `Added team member: ${name}`,
    },
  })

  revalidatePath('/business/users')
}
