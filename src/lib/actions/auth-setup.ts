'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { headers } from 'next/headers'
import { getAppBaseUrl } from '@/lib/config/app-url'
import { sendEmail, buildResetPasswordEmail } from '@/lib/email/send-email'

function generateRawToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function getAppBase(): string {
  try {
    const h = headers()
    return getAppBaseUrl({ headers: h })
  } catch {
    return getAppBaseUrl()
  }
}

export async function requestPasswordReset(formData: FormData) {
  const email = formData.get('email') as string

  if (!email) {
    redirect('/forgot-password?error=Email+required')
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    // Always show generic message
    redirect('/forgot-password?success=If+an+account+exists,+a+reset+link+has+been+sent')
  }

  // Invalidate old reset tokens
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, type: 'RESET_PASSWORD', usedAt: null },
    data: { usedAt: new Date(0) },
  })

  const raw = generateRawToken()
  const tokenHash = hashToken(raw)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, type: 'RESET_PASSWORD', expiresAt },
  })

  const link = `${getAppBase()}/set-password?token=${raw}`
  const emailContent = buildResetPasswordEmail(link)
  await sendEmail({ to: email, ...emailContent })

  await prisma.auditLog.create({
    data: { action: 'PASSWORD_RESET_REQUESTED', entity: 'User', entityId: user.id, details: `Password reset requested for ${email}` },
  })

  redirect('/forgot-password?success=If+an+account+exists,+a+reset+link+has+been+sent')
}

export async function setPassword(formData: FormData) {
  const token = formData.get('token') as string
  const password = formData.get('password') as string
  const tokenHash = hashToken(token)

  if (!token || !password) {
    redirect('/login?error=Invalid+request')
  }

  if (password.length < 8) {
    redirect(`/set-password?token=${token}&error=Password+must+be+at+least+8+characters`)
  }

  const record = await prisma.passwordResetToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gte: new Date() } },
  })

  if (!record) {
    redirect('/login?error=Invalid+or+expired+token')
  }

  const passwordHash = await bcrypt.hash(password, 12)

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    })

    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, isActive: true },
    })

    await tx.auditLog.create({
      data: { userId: record.userId, action: 'PASSWORD_SET', entity: 'User', entityId: record.userId, details: `Password set via ${record.type} token` },
    })
  })

  redirect('/login?success=Password+set+successfully.+Please+log+in')
}
