'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'

const STEPS = ['CONFIGURING', 'AUTHENTICATED', 'CONNECTED', 'PLANS_SYNCED', 'PLANS_IMPORTED', 'PURCHASE_TESTED', 'USAGE_TESTED', 'TOPUP_TESTED', 'CERTIFIED'] as const
export type CertStep = (typeof STEPS)[number]

export const STEP_LABELS: Record<string, string> = {
  CONFIGURING: 'Configure', AUTHENTICATED: 'Authenticate', CONNECTED: 'Test Connection',
  PLANS_SYNCED: 'Sync Plans', PLANS_IMPORTED: 'Import Plans', PURCHASE_TESTED: 'Test Purchase',
  USAGE_TESTED: 'Test Usage', TOPUP_TESTED: 'Test Top-up', CERTIFIED: 'Certified',
}

export async function advanceCertification(providerId: string): Promise<{ success: boolean; step: CertStep; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, step: 'CONFIGURING', error: 'Unauthorized' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, step: 'CONFIGURING', error: 'Provider not found' }

  const current = (provider.certificationStatus || 'CONFIGURING') as CertStep
  const idx = STEPS.indexOf(current)
  if (idx >= STEPS.length - 1) return { success: true, step: current }

  const nextStep = STEPS[idx + 1]

  // For each step, run the corresponding check
  try {
    if (nextStep === 'AUTHENTICATED') {
      const hasToken = provider.apiToken != null
      if (!hasToken) return { success: false, step: current, error: 'No API token. Authenticate first.' }
    }

    if (nextStep === 'CONNECTED') {
      const hasConnection = provider.lastSuccessfulConnection != null
      if (!hasConnection) return { success: false, step: current, error: 'No successful connection. Test connection first.' }
    }

    if (nextStep === 'PLANS_SYNCED') {
      const hasSync = provider.lastSyncAt != null
      if (!hasSync) return { success: false, step: current, error: 'No plans synced. Sync plans first.' }
    }

    await prisma.provider.update({
      where: { id: providerId },
      data: {
        certificationStatus: nextStep,
        lastCertificationRunAt: new Date(),
        ...(nextStep === 'CERTIFIED' ? { certifiedAt: new Date() } : {}),
      },
    })

    revalidatePath(`/admin/providers/${providerId}`)
    return { success: true, step: nextStep }
  } catch (e: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: { certificationStatus: 'FAILED', certificationNotes: e.message || 'Certification step failed' },
    })
    return { success: false, step: current, error: e.message || 'Step failed' }
  }
}

export async function resetCertification(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return

  await prisma.provider.update({
    where: { id: providerId },
    data: { certificationStatus: 'CONFIGURING', certifiedAt: null, lastCertificationRunAt: null, certificationNotes: null },
  })
  revalidatePath(`/admin/providers/${providerId}`)
}
