'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

const SETTING_KEYS = new Set(['appName', 'appDescription', 'supportEmail', 'defaultCurrency'])

export async function updateSetting(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  const userId = session.user.id

  const entries = Array.from(formData.entries())
  for (const [key, value] of entries) {
    if (!SETTING_KEYS.has(key)) continue
    await prisma.setting.upsert({
      where: { key },
      update: { value: value as string },
      create: { key, value: value as string },
    })
  }

  await prisma.auditLog.create({
    data: { userId, action: 'UPDATE', entity: 'Setting', details: `Updated platform settings` },
  })

  revalidatePath('/admin/settings')
}
