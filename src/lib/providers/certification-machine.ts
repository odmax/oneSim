import { prisma } from '@/lib/prisma'

/**
 * Valid certification state transitions
 */
const TRANSITIONS: Record<string, string[]> = {
  CONFIGURING: ['AUTHENTICATED'],
  AUTHENTICATED: ['CONNECTED', 'AUTHENTICATED'],
  CONNECTED: ['PLANS_SYNCED', 'CONNECTED'],
  PLANS_SYNCED: ['PLANS_IMPORTED', 'PLANS_SYNCED'],
  PLANS_IMPORTED: ['PURCHASE_TESTED', 'PLANS_IMPORTED'],
  PURCHASE_TESTED: ['USAGE_TESTED', 'PURCHASE_TESTED'],
  USAGE_TESTED: ['TOPUP_TESTED', 'USAGE_TESTED'],
  TOPUP_TESTED: ['CERTIFIED', 'TOPUP_TESTED'],
  CERTIFIED: [],
  FAILED: ['CONFIGURING'],
}

/**
 * Try to advance certification to the given target step.
 * Only allows valid transitions per the state machine.
 * Thread-safe best-effort — never throws.
 */
export async function advanceCertificationTo(providerId: string, targetStep: string): Promise<void> {
  try {
    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { certificationStatus: true },
    })
    if (!provider) return

    const current = provider.certificationStatus || 'CONFIGURING'
    const allowed = TRANSITIONS[current] || []

    // Walk through allowed transitions step by step
    if (allowed.length === 0) return

    let nextStep: string | null = null
    if (allowed.includes(targetStep)) {
      nextStep = targetStep
    } else {
      // Auto-advance through intermediate steps
      const allSteps = ['CONFIGURING', 'AUTHENTICATED', 'CONNECTED', 'PLANS_SYNCED', 'PLANS_IMPORTED', 'PURCHASE_TESTED', 'USAGE_TESTED', 'TOPUP_TESTED', 'CERTIFIED']
      const currentIdx = allSteps.indexOf(current)
      const targetIdx = allSteps.indexOf(targetStep)
      if (currentIdx >= 0 && targetIdx > currentIdx) {
        nextStep = allSteps[Math.min(targetIdx, currentIdx + 1)]
      }
    }

    if (nextStep && allowed.includes(nextStep)) {
      await prisma.provider.update({
        where: { id: providerId },
        data: {
          certificationStatus: nextStep,
          lastCertificationRunAt: new Date(),
          ...(nextStep === 'CERTIFIED' ? { certifiedAt: new Date() } : {}),
        },
      })
    }
  } catch {
    // Best-effort — certification advance must never break the calling operation
  }
}

/**
 * Mark certification as failed for a provider.
 */
export async function markCertificationFailed(providerId: string, error: string): Promise<void> {
  try {
    await prisma.provider.update({
      where: { id: providerId },
      data: { certificationStatus: 'FAILED', certificationNotes: error?.slice(0, 500) || 'Unknown error', lastCertificationRunAt: new Date() },
    })
  } catch { /* best-effort */ }
}
