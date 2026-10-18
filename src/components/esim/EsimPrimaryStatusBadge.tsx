/**
 * ONE shared, provider-neutral primary status badge for eSIM inventory lists
 * (Business + Admin).
 *
 * Both inventory pages render exactly this component — the same resolver
 * (`deriveEsimInventoryStatus`) and the same labels/colors for every eSIM and
 * every provider. No provider-name, provider-capability, or raw-provider
 * conditional lives here: the badge consumes ONLY normalized OneSIM columns.
 *
 * The primary badge prefers the canonical ladder (Depleted → Low → Active →
 * Installed on device → Ready to install) and preserves exceptional lifecycle
 * states (Expired / Failed / Suspended / Cancelled / Refunded) verbatim.
 * "Ready to install" means usable profile/activation details are available —
 * available-to-install only, never a claim that the customer has not already
 * installed. A provider-reported DOWNLOADED checkpoint renders the distinct
 * evidence-exact "Profile downloaded". The tooltip carries the exact normalized
 * evidence (including whether installation was provider-confirmed vs
 * customer-confirmed) so the evidence source stays auditable.
 *
 * Detailed diagnostics (service lifecycle, installation-details availability,
 * current device-installation evidence + last check, usage used/total/remaining
 * + last usage check + staleness, and status polling last/next check) stay
 * available through a restrained `title` tooltip. Raw provider status and raw
 * provider payloads are never read or rendered here.
 */

import {
  deriveEsimInventoryStatus,
  type InventoryStatusRow,
  type EsimPrimaryStatus,
} from '@/lib/esim/inventory-status'

export type PrimaryBadgeTone = 'success' | 'warn' | 'danger' | 'neutral'

/** One consistent color per tone — identical on Business and Admin, every provider. */
const TONE_CLASSES: Record<PrimaryBadgeTone, string> = {
  success: 'bg-green-100 text-green-800',
  warn: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-800',
  neutral: 'bg-gray-100 text-gray-700',
}

function shortUtc(value: string | null | undefined): string {
  if (!value) return ''
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** Restrained tooltip: the primary badge + the exact normalized evidence behind it. */
function statusTooltip(primary: EsimPrimaryStatus, inv: ReturnType<typeof deriveEsimInventoryStatus>): string {
  const lines: string[] = [primary.label]
  if (primary.evidence.length > 0) lines.push(`Evidence: ${primary.evidence.join('; ')}`)
  lines.push(`Lifecycle: ${inv.service.label}`)
  lines.push(inv.installation.label)
  const deviceParts = [inv.device.label]
  if (inv.device.checkedAt) deviceParts.push(`last check ${shortUtc(inv.device.checkedAt)}`)
  lines.push(`Device: ${deviceParts.join(' · ')}`)
  const usageParts = [inv.usage.label]
  if (inv.usage.hasSnapshot && inv.usage.stale) usageParts.push('stale snapshot')
  if (inv.usage.lastUsageCheckAt) usageParts.push(`last usage check ${shortUtc(inv.usage.lastUsageCheckAt)}`)
  lines.push(`Usage: ${usageParts.join(' · ')}`)
  const pollingParts = [inv.polling.label]
  if (inv.polling.lastCheckAt) pollingParts.push(`last status check ${shortUtc(inv.polling.lastCheckAt)}`)
  if (inv.polling.nextSyncAt) pollingParts.push(`next ${shortUtc(inv.polling.nextSyncAt)}`)
  lines.push(`Status check: ${pollingParts.join(' · ')}`)
  return lines.join('\n')
}

export function EsimPrimaryStatusBadge({
  esim,
  now,
}: {
  esim: InventoryStatusRow
  now?: Date
}) {
  const inv = deriveEsimInventoryStatus(esim, now)
  const { label, tone } = inv.primary
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold leading-5 ${TONE_CLASSES[tone] || TONE_CLASSES.neutral}`}
      title={statusTooltip(inv.primary, inv)}
    >
      {label}
    </span>
  )
}