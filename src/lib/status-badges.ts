import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import { orderStatusLabel } from '@/lib/status-labels'

/**
 * Admin (internal operator) status badges.
 *
 * Every canonical status renders a customer-safe label and a distinct color —
 * never raw identifiers / "Unknown". Existing admin tones are preserved where
 * they exist; the canonical tone supersedes only for statuses the admin tables
 * did not previously color (DEPLETED, REFUNDED, PROCESSING, RESERVED,
 * INSTALLING, INSTALLED, CANCELLED, ...).
 */

export interface AdminStatusBadge {
  label: string
  className: string
}

/** Admin eSIM badge colors — keep existing hues, extend with the missing canonical ones. */
const ADMIN_ESIM_COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  PENDING_ACTIVATION: 'bg-yellow-100 text-yellow-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  PROCESSING: 'bg-blue-100 text-blue-800',
  RESERVED: 'bg-purple-100 text-purple-800',
  INSTALLING: 'bg-sky-100 text-sky-800',
  INSTALLED: 'bg-teal-100 text-teal-800',
  SUSPENDED: 'bg-orange-100 text-orange-800',
  DEPLETED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-red-100 text-red-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-red-100 text-red-800',
  REFUNDED: 'bg-rose-100 text-rose-800',
}

const ESIM_TONE_FALLBACK: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-800',
  neutral: 'bg-gray-100 text-gray-700',
}

export function adminEsimStatusBadge(status: string | null | undefined): AdminStatusBadge {
  const key = String(status || '').toUpperCase()
  const label = getEsimStatusLabel(status).label
  const className = ADMIN_ESIM_COLORS[key] ?? ESIM_TONE_FALLBACK[getEsimStatusLabel(status).tone] ?? 'bg-gray-100 text-gray-700'
  return { label, className }
}

/** Admin order badge colors mirrored from the business label map (incl. PROCESSING/PENDING). */
const ADMIN_ORDER_COLORS: Record<string, string> = {
  CREATED: 'bg-gray-100 text-gray-700',
  PAYMENT_RESERVED: 'bg-blue-100 text-blue-700',
  PENDING_PROVIDER: 'bg-amber-100 text-amber-700',
  PROVIDER_ACCEPTED: 'bg-cyan-100 text-cyan-700',
  RESERVED: 'bg-purple-100 text-purple-700',
  FULFILLING: 'bg-indigo-100 text-indigo-700',
  FULFILLED: 'bg-emerald-100 text-emerald-700',
  INSTALLING: 'bg-sky-100 text-sky-700',
  INSTALLED: 'bg-teal-100 text-teal-700',
  ACTIVE: 'bg-green-100 text-green-700',
  EXPIRED: 'bg-gray-100 text-gray-700',
  CANCELLED: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-rose-100 text-rose-700',
  PROVIDER_RECONCILIATION: 'bg-purple-100 text-purple-800',
  PARTIALLY_FULFILLED: 'bg-amber-100 text-amber-800',
  PROCESSING: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-gray-100 text-gray-700',
}

const ORDER_TONE_FALLBACK: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  warn: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
  neutral: 'bg-gray-100 text-gray-700',
}

export function adminOrderStatusBadge(status: string | null | undefined): AdminStatusBadge {
  const key = String(status || '').toUpperCase()
  const label = orderStatusLabel(status || '').label
  const className = ADMIN_ORDER_COLORS[key] ?? 'bg-gray-100 text-gray-700'
  return { label, className }
}