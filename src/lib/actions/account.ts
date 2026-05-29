'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'

export async function updateAccount(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session) {
    redirect('/login')
  }

  const action = formData.get('action') as string

  if (action === 'password') {
    // Change password
    const currentPassword = formData.get('currentPassword') as string
    const newPassword = formData.get('newPassword') as string
    const confirmPassword = formData.get('confirmPassword') as string

    if (!currentPassword || !newPassword || !confirmPassword) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=invalid_input`)
    }

    if (newPassword !== confirmPassword) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=password_mismatch`)
    }

    if (newPassword.length < 6) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=invalid_input`)
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { passwordHash: true }
    })

    if (!user || !user.passwordHash) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=update_failed`)
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash)
    
    if (!isPasswordValid) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=wrong_password`)
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10)

    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { passwordHash: newPasswordHash }
      })

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'UPDATE', entity: 'User', entityId: session.user.id, details: 'Changed password' },
      })
    } catch (error) {
      console.error('Password change error:', error)
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=update_failed`)
    }

    revalidatePath(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account`)
    redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?success=password`)
  } else {
    // Update profile
    const name = formData.get('name') as string
    const email = formData.get('email') as string

    if (!name || !email) {
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=invalid_input`)
    }

    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { name, email }
      })

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'UPDATE', entity: 'User', entityId: session.user.id, details: 'Updated profile information' },
      })
    } catch (error) {
      console.error('Profile update error:', error)
      redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?error=update_failed`)
    }

    revalidatePath(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account`)
    redirect(`/${session.user.role === 'INTERNAL_ADMIN' ? 'admin' : 'business'}/account?success=profile`)
  }
}
