/**
 * Provider-neutral eSIM inventory status fields.
 *
 * Server-compatible presentational component (no hooks, no client refs).
 * Renders the canonical separate inventory fields derived by
 * `deriveEsimInventoryStatus`:
 *   - Service lifecycle  (optional; hide on lists that already show a canonical
 *     status column)
 *   - Installation details available
 *   - Device installation (evidence-only; never inferred from READY / QR / a raw
 *     provider ACTIVE claim)
 *   - Usage: used / total / remaining and the last usage check when the
 *     snapshot is authoritative; exactly "Usage unavailable" otherwise
 *   - Status polling state, last check time and next scheduled check
 *     (from the scheduler bookkeeping via statusNextSyncAt)
 *
 * Raw provider status/raw provider payloads are never read or rendered here.
 */

import { deriveEsimInventoryStatus, type InventoryStatusRow } from '@/lib/esim/inventory-status'

export type InventoryFieldTone = 'success' | 'warn' | 'danger' | 'neutral'

const FIELD_TEXT: Record<InventoryFieldTone, string> = {
  success: 'text-emerald-700',
  warn: 'text-amber-700',
  danger: 'text-red-700',
  neutral: 'text-gray-600',
}

const FIELD_BADGE: Record<InventoryFieldTone, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
}

function Field({ label, value, tone, title }: { label: string; value: string; tone: InventoryFieldTone; title?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${FIELD_BADGE[tone] || FIELD_BADGE.neutral}`} title={title}>
        {value}
      </span>
      <span className={`text-[10px] ${FIELD_TEXT[tone] || FIELD_TEXT.neutral}`}>{label}</span>
    </div>
  )
}

function usageTitle(inv: ReturnType<typeof deriveEsimInventoryStatus>['usage']): string | undefined {
  if (!inv.hasSnapshot) return undefined
  const parts: string[] = []
  if (inv.usedLabel) parts.push(`Used ${inv.usedLabel}`)
  if (inv.totalLabel) parts.push(`Total ${inv.totalLabel}`)
  if (inv.remainingLabel) parts.push(`Remaining ${inv.remainingLabel}`)
  if (inv.lastUsageCheckAt) parts.push(`Last usage check ${new Date(inv.lastUsageCheckAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function EsimInventoryStatusFields({
  esim,
  hideService = false,
  now,
}: {
  esim: InventoryStatusRow
  hideService?: boolean
  now?: Date
}) {
  const inv = deriveEsimInventoryStatus(esim, now)

  const pollingTitleParts: string[] = []
  if (inv.polling.lastCheckAt) pollingTitleParts.push(`Last checked ${new Date(inv.polling.lastCheckAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`)
  if (inv.polling.nextSyncAt) pollingTitleParts.push(`Next check ${new Date(inv.polling.nextSyncAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`)

  return (
    <div className="space-y-1.5 text-xs">
      {!hideService && (
        <Field label="Lifecycle" value={inv.service.label} tone={inv.service.tone} title={`Service status: ${inv.service.status}`} />
      )}
      <Field label="Installation details" value={inv.installation.label} tone={inv.installation.tone} />
      <Field
        label="Device installation"
        value={inv.device.label}
        tone={inv.device.tone}
        title={(inv.device.evidence.length > 0 ? `Evidence: ${inv.device.evidence.join('; ')}` : inv.device.label) +
          (inv.device.checkedAt ? ` · status check ${new Date(inv.device.checkedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '')}
      />
      <Field
        label="Usage"
        value={inv.usage.label}
        tone={inv.usage.tone}
        title={usageTitle(inv.usage)}
      />
      <Field
        label="Status check"
        value={inv.polling.label}
        tone={inv.polling.tone}
        title={pollingTitleParts.length > 0 ? pollingTitleParts.join(' · ') : inv.polling.label}
      />
    </div>
  )
}
