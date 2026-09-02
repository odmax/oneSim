/**
 * Business-facing (customer-facing) status presentation labels.
 *
 * Single source of truth for rendering internal order/eSIM/wallet/API-key etc.
 * status enums to business users as stable, accurate customer language.
 * Internal diagnostic pages may retain technical state where useful.
 */

export interface StatusLabelStyle {
  label: string
  dot: string
  bg: string
}

export const ORDER_STATUS_LABELS: Record<string, StatusLabelStyle> = {
  CREATED: { label: 'Created', dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-600' },
  PAYMENT_RESERVED: { label: 'Payment Reserved', dot: 'bg-blue-400', bg: 'bg-blue-50 text-blue-600' },
  PENDING_PROVIDER: { label: 'Activating', dot: 'bg-amber-400', bg: 'bg-amber-50 text-amber-600' },
  PROVIDER_ACCEPTED: { label: 'Activating', dot: 'bg-cyan-400', bg: 'bg-cyan-50 text-cyan-600' },
  RESERVED: { label: 'Reserved', dot: 'bg-purple-400', bg: 'bg-purple-50 text-purple-600' },
  FULFILLING: { label: 'Fulfilling', dot: 'bg-indigo-400', bg: 'bg-indigo-50 text-indigo-600' },
  FULFILLED: { label: 'Ready to Install', dot: 'bg-emerald-400', bg: 'bg-emerald-50 text-emerald-600' },
  INSTALLING: { label: 'Installing', dot: 'bg-sky-400', bg: 'bg-sky-50 text-sky-600' },
  INSTALLED: { label: 'Installed', dot: 'bg-teal-400', bg: 'bg-teal-50 text-teal-600' },
  ACTIVE: { label: 'Active', dot: 'bg-green-400', bg: 'bg-green-50 text-green-600' },
  EXPIRED: { label: 'Expired', dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-500' },
  CANCELLED: { label: 'Cancelled', dot: 'bg-amber-400', bg: 'bg-amber-50 text-amber-600' },
  FAILED: { label: 'Failed', dot: 'bg-red-400', bg: 'bg-red-50 text-red-600' },
  REFUNDED: { label: 'Refunded', dot: 'bg-rose-400', bg: 'bg-rose-50 text-rose-600' },
  PROVIDER_RECONCILIATION: { label: 'Reconciling', dot: 'bg-purple-400', bg: 'bg-purple-50 text-purple-700' },
  PARTIALLY_FULFILLED: { label: 'Partial', dot: 'bg-orange-400', bg: 'bg-orange-50 text-orange-700' },
}

export function orderStatusLabel(status: string): StatusLabelStyle {
  return ORDER_STATUS_LABELS[status] || { label: status, dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-500' }
}

const ORDER_EVENT_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PAYMENT_RESERVED: 'Payment reserved',
  PROVIDER_DISPATCHED: 'Sent to provider',
  PROVIDER_ACCEPTED: 'Accepted by carrier',
  PROVIDER_RECONCILIATION: 'Verifying with carrier',
  FULFILLED: 'Order fulfilled',
  INSTALLING: 'Installing',
  INSTALLED: 'Installed',
  ACTIVE: 'Active',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

export function orderEventLabel(eventType: string): string {
  return ORDER_EVENT_LABELS[eventType] || eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export const WALLET_TX_TYPE_LABELS: Record<string, string> = {
  TOPUP: 'Credit',
  TOP_UP: 'Credit',
  PURCHASE: 'Purchase',
  DEBIT: 'Debit',
  RESERVE: 'Reserved',
  CAPTURE: 'Captured',
  RELEASE: 'Released',
  REFUND: 'Refund',
  CREDIT: 'Credit',
}

export function walletTxTypeLabel(type: string): string {
  return WALLET_TX_TYPE_LABELS[type] || type
}

export const API_KEY_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
}

export function apiKeyStatusLabel(status: string): string {
  return API_KEY_STATUS_LABELS[status] || status
}

export const INSTALL_STATUS_LABELS: Record<string, string> = {
  INSTALLED: 'Installed',
  PENDING: 'Pending',
  NOT_SENT: 'Not sent',
  SENT: 'Sent',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
}

export function installStatusLabel(status: string): string {
  return INSTALL_STATUS_LABELS[status] || `Installation: ${status}`
}

export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended',
}

export function customerStatusLabel(status: string): string {
  return CUSTOMER_STATUS_LABELS[status] || status
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** Format a numeric/Decimal amount as USD currency without float artifacts. */
export function formatCurrency(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return '—'
  return currency.format(n)
}
