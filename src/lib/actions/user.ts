'use server'

import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { revalidatePath } from 'next/cache'

export async function addTeamMember(formData: FormData) {
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
      action: 'CREATE',
      entity: 'BusinessUser',
      entityId: user.id,
      details: `Added team member: ${name}`,
    },
  })

  revalidatePath('/business/users')
}
