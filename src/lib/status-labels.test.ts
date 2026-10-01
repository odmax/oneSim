import { describe, it, expect } from 'vitest'
import {
  orderStatusLabel,
  orderEventLabel,
  walletTxTypeLabel,
  apiKeyStatusLabel,
  installStatusLabel,
  customerStatusLabel,
  formatCurrency,
} from './status-labels'

describe('orderStatusLabel', () => {
  it('maps known order statuses to friendly labels', () => {
    expect(orderStatusLabel('ACTIVE').label).toBe('Active')
    expect(orderStatusLabel('PENDING_PROVIDER').label).toBe('Activating')
    expect(orderStatusLabel('FULFILLED').label).toBe('Ready to Install')
    expect(orderStatusLabel('INSTALLED').label).toBe('Installed')
  })

  it('falls back to the raw enum for unknown statuses (no crash, stable shape)', () => {
    const fallback = orderStatusLabel('MADE_UP_STATUS')
    expect(fallback.label).toBe('MADE_UP_STATUS')
    expect(fallback.dot).toBeDefined()
    expect(fallback.bg).toBeDefined()
  })
})

describe('orderEventLabel', () => {
  it('maps known event types to friendly labels', () => {
    expect(orderEventLabel('ORDER_CREATED')).toBe('Order created')
    expect(orderEventLabel('FULFILLED')).toBe('Order fulfilled')
  })

  it('humanizes unknown event-type keys by splitting underscores', () => {
    expect(orderEventLabel('CARRIER_ACCEPTED')).toBe('CARRIER ACCEPTED')
  })
})

describe('walletTxTypeLabel', () => {
  it('maps TOPUP and PURCHASE to friendly labels', () => {
    expect(walletTxTypeLabel('TOPUP')).toBe('Credit')
    expect(walletTxTypeLabel('TOP_UP')).toBe('Credit')
    expect(walletTxTypeLabel('PURCHASE')).toBe('Purchase')
  })

  it('falls back to the raw type for unknown values', () => {
    expect(walletTxTypeLabel('MYSTERY')).toBe('MYSTERY')
  })
})

describe('apiKeyStatusLabel / installStatusLabel / customerStatusLabel', () => {
  it('maps api key statuses', () => {
    expect(apiKeyStatusLabel('ACTIVE')).toBe('Active')
    expect(apiKeyStatusLabel('REVOKED')).toBe('Revoked')
    expect(apiKeyStatusLabel('OTHER')).toBe('OTHER')
  })

  it('maps install statuses without leaking raw enums in the fallback', () => {
    expect(installStatusLabel('INSTALLED')).toBe('Installed')
    expect(installStatusLabel('PENDING')).toBe('Pending')
    expect(installStatusLabel('SENT')).toBe('Sent')
    expect(installStatusLabel('NOT_SENT')).toBe('Not sent')
    expect(installStatusLabel('UNKNOWN')).toBe('Unknown')
  })

  it('the no-install-data fallback maps DOWNLOADED to Profile downloaded (never Ready to install / Installed on device)', () => {
    expect(installStatusLabel('DOWNLOADED')).toBe('Profile downloaded')
    expect(installStatusLabel('DOWNLOADED')).not.toBe('Ready to install')
    expect(installStatusLabel('DOWNLOADED')).not.toBe('Installed on device')
    expect(installStatusLabel('DOWNLOADED')).not.toContain('Installation:')
  })

  it('READY (incl. Telna RELEASED) renders as Installation state unknown — never Ready/Ready to install', () => {
    expect(installStatusLabel('READY')).toBe('Installation state unknown')
    expect(installStatusLabel('READY')).not.toBe('Ready')
    expect(installStatusLabel('READY')).not.toBe('Ready to install')
    expect(installStatusLabel('READY')).not.toBe('Installed on device')
  })

  it('maps neighboring installation-status values to provider-neutral labels without leaking raw enums', () => {
    expect(installStatusLabel('ENABLED')).toBe('Installed')
    expect(installStatusLabel('INSTALLING')).toBe('Installing')
    expect(installStatusLabel('DISABLED')).toBe('Installed, disabled on device')
    expect(installStatusLabel('DELETED')).toBe('Removed from device')
    expect(installStatusLabel('READY')).toBe('Installation state unknown')
    expect(installStatusLabel('STALE')).toBe('Installation unavailable')
    expect(installStatusLabel('NOT_SUPPORTED')).toBe('Installation unavailable')
    expect(installStatusLabel('NOT_RECOVERABLE')).toBe('Installation unavailable')
    expect(installStatusLabel('PERMANENT_FAILURE')).toBe('Installation unavailable')
  })

  it('falls back to a neutral label for unknown/canonical values, never echoing the raw value', () => {
    expect(installStatusLabel('TOTALLY_NEW')).toBe('Unknown')
    expect(installStatusLabel('')).toBe('Unknown')
    expect(installStatusLabel('TOTALLY_NEW')).not.toContain('TOTALLY_NEW')
  })

  it('maps customer statuses', () => {
    expect(customerStatusLabel('ACTIVE')).toBe('Active')
    expect(customerStatusLabel('SUSPENDED')).toBe('Suspended')
  })
})

describe('formatCurrency', () => {
  it('formats numbers and numeric strings as USD without float artifacts', () => {
    expect(formatCurrency(12.5)).toBe('$12.50')
    expect(formatCurrency('0.1' + '0' + '0')).toBe('$0.10')
  })

  it('renders non-finite / invalid input as an em dash (no NaN/parts leaked)', () => {
    expect(formatCurrency(NaN)).toBe('—')
    expect(formatCurrency(Infinity)).toBe('—')
    expect(formatCurrency('not-a-number')).toBe('—')
  })
})