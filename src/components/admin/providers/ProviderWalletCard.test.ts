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

  it('gates the wallet card on the BALANCE capability: AirHub, Choice and Telna yes, iBASIS no', () => {
    const mk = (code: string) => ({ code, enabledCapabilities: null, type: 'CUSTOM' })
    expect(providerSupports(mk('AIRHUB'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('CHOICE'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('TELNA'), 'BALANCE')).toBe(true)
    expect(providerSupports(mk('IBASIS'), 'BALANCE')).toBe(false)
  })
})
