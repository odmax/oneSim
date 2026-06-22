'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { handlePrismaError } from '@/lib/errors/handle-prisma-error'

const basePath = (role: string) => role === 'INTERNAL_ADMIN' ? '/admin/account' : '/business/account'

export async function updateAccount(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')

  const role = session.user.role
  const bp = basePath(role)

  const action = formData.get('action') as string

  if (action === 'password') {
    const currentPassword = formData.get('currentPassword') as string
    const newPassword = formData.get('newPassword') as string
    const confirmPassword = formData.get('confirmPassword') as string

    if (!currentPassword || !newPassword || !confirmPassword) redirect(`${bp}?error=invalid_input`)
    if (newPassword !== confirmPassword) redirect(`${bp}?error=password_mismatch`)
    if (newPassword.length < 6) redirect(`${bp}?error=invalid_input`)

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { passwordHash: true },
    })
    if (!user || !user.passwordHash) redirect(`${bp}?error=update_failed`)

    const isPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isPasswordValid) redirect(`${bp}?error=wrong_password`)

    try {
      const newPasswordHash = await bcrypt.hash(newPassword, 10)
      await prisma.user.update({
        where: { id: session.user.id },
        data: { passwordHash: newPasswordHash },
      })

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'UPDATE', entity: 'User', entityId: session.user.id, details: 'Changed password' },
      })
    } catch (error: any) {
      const { message } = handlePrismaError(error, 'Password update failed')
      console.error('Password change error:', message)
      redirect(`${bp}?error=update_failed`)
    }

    revalidatePath(bp)
    redirect(`${bp}?success=password`)
  } else {
    const name = formData.get('name') as string
    const email = formData.get('email') as string

    if (!name || !email) redirect(`${bp}?error=invalid_input`)

    // Check for duplicate email before updating
    if (email !== session.user.email) {
      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing && existing.id !== session.user.id) {
        redirect(`${bp}?error=email_duplicate`)
      }
    }

    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { name, email },
      })

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'UPDATE', entity: 'User', entityId: session.user.id, details: `Updated profile: name=${name}, email=${email}` },
      })
    } catch (error: any) {
      const { message } = handlePrismaError(error, 'Profile update failed')
      console.error('Profile update error:', message)
      redirect(`${bp}?error=update_failed`)
    }

    revalidatePath(bp)
    // If email changed, inform user they may need to re-login for session to reflect
    const successType = email !== session.user.email ? 'email_changed' : 'profile'
    redirect(`${bp}?success=${successType}`)
  }
}
