'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function updateSetting(formData: FormData) {
  const entries = Array.from(formData.entries())
  
  for (const [key, value] of entries) {
    await prisma.setting.upsert({
      where: { key },
      update: { value: value as string },
      create: { key, value: value as string },
    })
  }

  await prisma.auditLog.create({
    data: {
      action: 'UPDATE',
      entity: 'Setting',
      details: `Updated platform settings`,
    },
  })

  revalidatePath('/admin/settings')
}
