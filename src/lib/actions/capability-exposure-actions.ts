'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'

export async function toggleCapabilityExposure(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const providerId = formData.get('providerId') as string
  const capability = formData.get('capability') as string
  const field = formData.get('field') as string // 'clientPortalEnabled' or 'clientApiEnabled'
  const value = formData.get('value') === 'true'

  await prisma.$executeRawUnsafe(
    `INSERT INTO provider_capability_exposure ("providerId", capability, "clientPortalEnabled", "clientApiEnabled", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("providerId", capability)
     DO UPDATE SET "${field}" = $5, "updatedAt" = NOW()`,
    providerId, capability, field === 'clientPortalEnabled' ? value : false, field === 'clientApiEnabled' ? value : false, value
  )

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'TOGGLE_CAPABILITY_EXPOSURE', entity: 'Provider', entityId: providerId,
      details: `${capability} ${field}=${value}` },
  }).catch(() => {})

  redirect(`/admin/providers/${providerId}?success=exposure_updated`)
}
