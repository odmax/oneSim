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