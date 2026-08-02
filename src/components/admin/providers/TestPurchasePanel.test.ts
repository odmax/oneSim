import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/actions/provider-test-purchase', () => ({
  testProviderPurchase: vi.fn(),
}))

import { TestPurchasePanel } from './TestPurchasePanel'

function renderPanel(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(TestPurchasePanel as any, props))
}

describe('TestPurchasePanel travel-date input', () => {
  it('renders the travel date input with name="travelDate"', () => {
    const html = renderPanel({ providerId: 'p1', packages: [], forceTravelDateRequired: false })
    expect(html).toContain('name="travelDate"')
    expect(html).toContain('type="date"')
  })

  it('requires the travel date input for the AirHub admin test flow', () => {
    const html = renderPanel({ providerId: 'p1', packages: [], forceTravelDateRequired: true })
    expect(html).toContain('name="travelDate"')
    expect(html).toContain('required')
    expect(html).toContain('(required)')
  })

  it('keeps the travel date optional for non-AirHub providers', () => {
    const html = renderPanel({ providerId: 'p1', packages: [], forceTravelDateRequired: false })
    expect(html).toContain('(optional)')
    expect(html).not.toContain('required=""')
  })
})
