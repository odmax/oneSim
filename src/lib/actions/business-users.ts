'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { handlePrismaError } from '@/lib/errors/handle-prisma-error'

export async function addTeamMember(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  if (session.user.businessRole !== 'ADMIN') {
    return { error: 'Permission denied' }
  }

  const name = formData.get('name') as string
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const role = formData.get('role') as 'ADMIN' | 'MEMBER'

  if (!name || name.trim() === '') {
    return { error: 'Name is required' }
  }

  if (!email || email.trim() === '') {
    return { error: 'Email is required' }
  }

  if (!password || password.length < 8) {
    return { error: 'Password must be at least 8 characters' }
  }

  if (!role || (role !== 'ADMIN' && role !== 'MEMBER')) {
    return { error: 'Role is required' }
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return { error: 'Duplicate email: This email is already in use' }
    }

    const bcrypt = await import('bcryptjs')
    const passwordHash = await bcrypt.default.hash(password, 10)

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: 'BUSINESS_USER',
          isActive: true,
        },
      })

      const businessUser = await tx.businessUser.create({
        data: {
          userId: user.id,
          businessId: session.user.businessId!,
          role,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'CREATE',
          entity: 'BusinessUser',
          entityId: user.id,
          details: `Added team member: ${name} with role ${role}`,
        },
      })

      return { user, businessUser }
    })

    revalidatePath('/business/users')
    return { success: true, email, password, name }
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return { error: 'Duplicate email: This email is already in use' }
    }
    return { error: 'Failed to create team member. Please try again.' }
  }
}

export async function removeTeamMember(userId: string) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  if (session.user.businessRole !== 'ADMIN') {
    return { error: 'Permission denied' }
  }

  if (userId === session.user.id) {
    return { error: 'Cannot remove yourself' }
  }

  try {
    const targetBusinessUser = await prisma.businessUser.findFirst({
      where: {
        userId,
        businessId: session.user.businessId!,
      },
      include: { user: true },
    })

    if (!targetBusinessUser) {
      return { error: 'User not found' }
    }

    const firstBusinessUser = await prisma.businessUser.findFirst({
      where: { businessId: session.user.businessId! },
      orderBy: { createdAt: 'asc' },
    })

    if (firstBusinessUser && firstBusinessUser.userId === userId) {
      return { error: 'Cannot remove main admin' }
    }

    if (targetBusinessUser.role === 'ADMIN') {
      const adminCount = await prisma.businessUser.count({
        where: {
          businessId: session.user.businessId!,
          role: 'ADMIN',
        },
      })

      if (adminCount <= 1) {
        return { error: 'Cannot remove last admin. At least one Business Admin must remain.' }
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.businessUser.deleteMany({
        where: {
          userId,
          businessId: session.user.businessId!,
        },
      })

      await tx.user.delete({
        where: { id: userId },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'DELETE',
          entity: 'BusinessUser',
          entityId: userId,
          details: `Removed team member ${targetBusinessUser.user?.name || userId}`,
        },
      })
    })

    revalidatePath('/business/users')
    return { success: 'Team member removed successfully' }
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to remove team member')
    return { error: message }
  }
}
