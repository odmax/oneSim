import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/actions/airhub-wallet', () => ({
  fetchAirhubWallet: vi.fn(),
}))

import ProviderWalletCard from './ProviderWalletCard'
import { providerSupports } from '@/lib/providers/capabilities/index'

const baseProps = {
  providerId: 'p1',
  providerCode: 'AIRHUB',
  initialBalance: null,
  initialCurrency: null,
  initialStatus: null,
  initialLastSync: null,
  initialError: null,
  initialThreshold: null,
}

function renderCard(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(ProviderWalletCard as any, { ...baseProps, ...props }))
}

describe('ProviderWalletCard — single balance card', () => {
  it('renders only the Provider Wallet card, never a legacy Running Balance panel', () => {
    const html = renderCard({})
    expect(html).toContain('Provider Wallet')
    expect(html).not.toContain('Running Balance')
  })

  it('shows "Balance unavailable" (not $0.00) when a parse failure created a zero record', () => {
    const html = renderCard({ initialBalance: 0, initialStatus: 'ERROR', initialError: 'AirHub wallet balance unavailable: getwallet is an object but no numeric balance field was found' })
    expect(html).toContain('Balance unavailable')
    expect(html).not.toContain('$0.00')
    expect(html).toContain('no numeric balance field was found')
  })

  it('preserves the last valid balance after a later refresh failure', () => {
    const html = renderCard({ initialBalance: 100, initialStatus: 'ERROR', initialLastSync: new Date().toISOString(), initialError: 'Wallet fetch failed: HTTP 500' })
    expect(html).toContain('$100.00')
    expect(html).toContain('Error')
    expect(html).toContain('Wallet fetch failed: HTTP 500')
    expect(html).not.toContain('Balance unavailable')
  })

  it('shows Connected only after a successful parsed balance', () => {
    const ok = renderCard({ initialBalance: 250, initialCurrency: 'USD', initialStatus: 'OK', initialLastSync: new Date().toISOString() })
    expect(ok).toContain('Connected')
    expect(ok).toContain('$250.00')
    const never = renderCard({})
    expect(never).not.toContain('Connected')
  })

  it('keeps a valid zero balance as $0.00', () => {
    const html = renderCard({ initialBalance: 0, initialCurrency: 'USD', initialStatus: 'OK', initialLastSync: new Date().toISOString() })
    expect(html).toContain('$0.00')
    expect(html).toContain('Connected')
  })

  it('shows the live "$0.00 USD" wallet result as Connected, never Balance unavailable', () => {
    const html = renderCard({ initialBalance: 0, initialCurrency: 'USD', initialStatus: 'OK', initialLastSync: new Date().toISOString() })
    expect(html).toContain('$0.00')
    expect(html).toContain('USD')
    expect(html).toContain('Connected')
    expect(html).not.toContain('Balance unavailable')
  })

  it('displays the $5.00 vendor credit with currency, Connected status and a Last Synced timestamp', () => {
    const lastSync = new Date().toISOString()
    const html = renderCard({ initialBalance: 5, initialCurrency: 'USD', initialStatus: 'OK', initialLastSync: lastSync })
    expect(html).toContain('$5.00')
    expect(html).toContain('USD')
    expect(html).toContain('Connected')
    expect(html).not.toContain('>Never<')
  })

  it('displays a Choice balance through the shared wallet card', () => {
    const html = renderCard({ providerCode: 'CHOICE', initialBalance: 5, initialCurrency: 'USD', initialStatus: 'OK', initialLastSync: new Date().toISOString() })
    expect(html).toContain('$5.00')
    expect(html).toContain('USD')
    expect(html).toContain('Connected')
  })

  it('renders the error text exactly once when parsing fails', () => {
    const errMsg = 'AirHub wallet balance unavailable: getwallet is array but no numeric balance field was found'
    const html = renderCard({ initialBalance: 0, initialStatus: 'ERROR', initialError: errMsg })
    expect(html).toContain('Balance unavailable')
    const occurrences = html.split(errMsg).length - 1
    expect(occurrences).toBe(1)
    expect(html).not.toContain('$0.00')
  })

  it('renders a single stale-balance note when a later refresh fails', () => {
    const errMsg = 'Wallet fetch failed: HTTP 500'
    const html = renderCard({ initialBalance: 100, initialStatus: 'ERROR', initialLastSync: new Date().toISOString(), initialError: errMsg })
    expect(html).toContain('$100.00')
    const occurrences = html.split(errMsg).length - 1
    expect(occurrences).toBe(1)
  })

  it('gates the wallet card on the BALANCE capability: AirHub, Choice and Telna yes, iBASIS no', () => {
    const mk = (code: string) => ({ code, enabledCapabilities: null, type: 'CUSTOM' })
    expect(providerSupports(mk('AIRHUB'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('CHOICE'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('TELNA'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('IBASIS'), 'BALANCE')).toBe(false)
  })
})
