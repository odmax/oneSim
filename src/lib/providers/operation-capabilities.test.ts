import { describe, it, expect } from 'vitest'
import { providerSupportsOperation, providerOperationFromLabel } from './operation-capabilities'

describe('provider operation capability gate', () => {
  const defaultCapProvider = (code: string | null) => ({ code, enabledCapabilities: null })

  it('legacy providers resolve capability from code defaults (backward compatible)', () => {
    // Every configured strategy must retain PURCHASE_ESIM support through the
    // code-based defaults — no current provider becomes unsupported.
    for (const code of ['AIRHUB', 'CHOICE', 'IBASIS', 'TELNA', 'TELNA_SEAMLESS', 'USMATRIX']) {
      expect(providerSupportsOperation(defaultCapProvider(code), 'PURCHASE_ESIM')).toBe(true)
    }
  })

  it('explicit enabledCapabilities is authoritative', () => {
    const p = { code: 'AIRHUB', enabledCapabilities: ['AUTH', 'STATUS'] }
    expect(providerSupportsOperation(p, 'PURCHASE_ESIM')).toBe(false)
    expect(providerSupportsOperation(p, 'GET_STATUS')).toBe(true)
  })

  it('unknown code with no explicit capabilities supports nothing (fail-safe)', () => {
    expect(providerSupportsOperation(defaultCapProvider('SOMETHING_NEW'), 'PURCHASE_ESIM')).toBe(false)
  })

  it('maps generic operations to existing capability strings', () => {
    const p = {
      code: 'CHOICE',
      enabledCapabilities: ['PURCHASE', 'STATUS', 'USAGE', 'TOP_UP', 'SUSPEND', 'RESUME', 'QR_CODE', 'WEBHOOKS'],
    }
    expect(providerSupportsOperation(p, 'PURCHASE_ESIM')).toBe(true)
    expect(providerSupportsOperation(p, 'GET_STATUS')).toBe(true)
    expect(providerSupportsOperation(p, 'GET_USAGE')).toBe(true)
    expect(providerSupportsOperation(p, 'TOP_UP')).toBe(true)
    expect(providerSupportsOperation(p, 'SUSPEND')).toBe(true)
    expect(providerSupportsOperation(p, 'RESUME')).toBe(true)
    expect(providerSupportsOperation(p, 'REFRESH_QR')).toBe(true)
    expect(providerSupportsOperation(p, 'WEBHOOK_STATUS')).toBe(true)
  })

  it('STANDARD / HEADER_TOKEN (generic strategies) support purchase via defaults', () => {
    // These strategies have no dedicated code defaults block; they must resolve
    // via whatever explicit capabilities are configured. When none, they fail
    // safe (unsupported) — never crash, never fabricate support.
    expect(providerSupportsOperation({ code: 'STANDARD', enabledCapabilities: ['PURCHASE'] }, 'PURCHASE_ESIM')).toBe(true)
    expect(providerSupportsOperation({ code: 'HEADER_TOKEN', enabledCapabilities: ['PURCHASE'] }, 'PURCHASE_ESIM')).toBe(true)
    expect(providerSupportsOperation({ code: 'STANDARD', enabledCapabilities: null }, 'PURCHASE_ESIM')).toBe(false)
  })

  it('maps persisted operation labels to generic keys', () => {
    expect(providerOperationFromLabel('purchase')).toBe('PURCHASE_ESIM')
    expect(providerOperationFromLabel('PURCHASE')).toBe('PURCHASE_ESIM')
    expect(providerOperationFromLabel('activation')).toBe('GET_STATUS')
    expect(providerOperationFromLabel('topup')).toBe('TOP_UP')
    expect(providerOperationFromLabel(undefined)).toBe('GET_STATUS')
  })
})