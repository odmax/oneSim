'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { ProviderCapability, CAPABILITY_LABELS } from '@/lib/providers/capabilities/types'
import { getProviderCapabilityState, resolveEnabledCapabilities } from '@/lib/providers/capability-state'

export type SetCapabilityEnabledResult =
  | { success: true; capability: string; previousEnabled: boolean; newEnabled: boolean; changed: boolean }
  | { success: false; error: string }

const VALID_CAPABILITIES = new Set<string>(Object.values(ProviderCapability))

/**
 * Generically enable/disable a provider capability recorded in
 * `Provider.enabledCapabilities`.
 *
 * Provider-neutral (no provider-code branch). Semantics:
 *   - null / undefined          → "unconfigured" → documented defaults apply.
 *   - a present array (incl. [])→ "explicitly configured" → used EXACTLY.
 * When ENABLING we verify the provider connector actually supports the capability
 * (implementationState === 'SUPPORTED') before allowing it; enabling is idempotent.
 * When DISABLING an authorized operator may always disable; the persisted array is
 * kept explicit so disabling a default capability is never undone by the defaults
 * fallback.
 *
 * Enabling does NOT itself contact any provider — it only permits future
 * authorized provider-side mutations to pass their readiness gate.
 */
export async function setProviderCapabilityEnabled(
  providerId: string,
  capability: string,
  enabled: boolean,
): Promise<SetCapabilityEnabledResult> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS).catch(() => ({ allowed: false }))
  if (!perm.allowed) {
    return { success: false, error: 'Forbidden: missing MANAGE_PROVIDERS permission' }
  }

  if (!providerId) return { success: false, error: 'providerId is required' }
  if (!VALID_CAPABILITIES.has(capability)) {
    return { success: false, error: `Unknown capability: ${capability}` }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  const providerCode = provider.code || ''
  const currentExplicit = provider.enabledCapabilities === null || provider.enabledCapabilities === undefined
    ? null
    : Array.isArray(provider.enabledCapabilities) ? (provider.enabledCapabilities as unknown[]).map(String) : null

  const effectiveNow = resolveEnabledCapabilities(provider.enabledCapabilities, providerCode)
  const previousEnabled = effectiveNow.includes(capability)

  if (enabled && previousEnabled) {
    // Idempotent enable — already enabled.
    return { success: true, capability, previousEnabled: true, newEnabled: true, changed: false }
  }
  if (!enabled && !previousEnabled) {
    // Idempotent disable — already disabled.
    return { success: true, capability, previousEnabled: false, newEnabled: false, changed: false }
  }

  // Implementation-support guard: never let an operator enable a capability the
  // provider's connector does not genuinely implement/support.
  if (enabled) {
    const state = await getProviderCapabilityState(providerId).catch(() => null)
    const capState = state?.byKey[capability]
    if (!capState || capState.implementationState !== 'SUPPORTED') {
      return { success: false, error: `Cannot enable ${capability}: connector does not support it` }
    }
  }

  // Compute the new EXPLICIT list (never re-silently lose an explicit state to defaults).
  let next: string[]
  if (enabled) {
    const base = currentExplicit ?? resolveEnabledCapabilities(provider.enabledCapabilities, providerCode)
    next = Array.from(new Set([...base, capability]))
  } else {
    const base = currentExplicit ?? resolveEnabledCapabilities(provider.enabledCapabilities, providerCode)
    next = base.filter(c => c !== capability)
  }

  await prisma.provider.update({
    where: { id: providerId },
    data: { enabledCapabilities: next },
  })

  // Precise provider-neutral audit — no credentials/config secrets.
  // Actor is captured by AuditLog.userId; timestamp by createdAt.
  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PROVIDER_CAPABILITY_CHANGED',
      entity: 'Provider',
      entityId: providerId,
      details: `${CAPABILITY_LABELS[capability as ProviderCapability] || capability} capability ${enabled ? 'enabled' : 'disabled'} (previousEnabled=${previousEnabled}, newEnabled=${enabled})`,
    },
  }).catch(() => {})

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)

  return { success: true, capability, previousEnabled, newEnabled: enabled, changed: true }
}

/**
 * Form-action wrapper (must return void for <form action>). Reads the provider id,
 * capability and target enabled state from the submitted form (the form stores the
 * *desired* next state), delegates to setProviderCapabilityEnabled, then redirects
 * back to the provider page with the outcome encoded in the query string.
 */
export async function toggleProviderCapabilityEnabled(formData: FormData): Promise<void> {
  const providerId = formData.get('providerId') as string
  const capability = formData.get('capability') as string
  const enabled = formData.get('enabled') === 'true'

  const result = await setProviderCapabilityEnabled(providerId, capability, enabled)

  const base = `/admin/providers/${encodeURIComponent(providerId)}`
  if (result.success) {
    redirect(`${base}?success=capability_${enabled ? 'enabled' : 'disabled'}`)
  } else {
    redirect(`${base}?error=capability_change_failed_${encodeURIComponent(result.error || 'unknown')}`)
  }
}
