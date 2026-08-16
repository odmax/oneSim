import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UsageBar, UsageSummary } from './UsageBar'

function renderUsageBar(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(UsageBar as any, props))
}

function renderUsageSummary(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(UsageSummary as any, props))
}

describe('UsageBar', () => {
  it('renders "Usage unavailable" when there is no snapshot', () => {
    const html = renderUsageBar({ dataUsedMB: 0, dataTotalMB: null, dataRemainingMB: null })
    expect(html).toContain('Usage unavailable')
    expect(html).not.toContain('GB used')
  })

  it('renders a real 0.00 GB for valid zero usage instead of "Usage unavailable"', () => {
    const html = renderUsageBar({ dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024 })
    expect(html).toContain('0.00 GB')
    expect(html).toContain('of 1.00 GB')
    expect(html).toContain('0% used')
    expect(html).toContain('1.00 GB remaining')
    expect(html).not.toContain('Usage unavailable')
  })

  it('renders the live US-Matrix snapshot (800 / 10240 / 9440 MB) correctly', () => {
    const html = renderUsageBar({ dataUsedMB: 800, dataTotalMB: 10240, dataRemainingMB: 9440 })
    expect(html).toContain('0.78 GB') // used
    expect(html).toContain('of 10.00 GB') // total
    expect(html).toContain('9.22 GB remaining')
    expect(html).toContain('8% used') // 800/10240 = 7.8125% → rounded 8%
  })

  it('renders used/total/remaining/percentage from normalized MB values', () => {
    const html = renderUsageBar({ dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512 })
    expect(html).toContain('0.50 GB')
    expect(html).toContain('of 1.00 GB')
    expect(html).toContain('50% used')
    expect(html).toContain('0.50 GB remaining')
    expect(html).toContain('style="width:50%"')
  })

  it('renders the optional label', () => {
    const html = renderUsageBar({ label: 'Data Usage', dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512 })
    expect(html).toContain('Data Usage')
  })
})

describe('UsageSummary', () => {
  it('shows Data Used / Total Data / Remaining when a snapshot exists', () => {
    const html = renderUsageSummary({ dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512 })
    expect(html).toContain('Data Used')
    expect(html).toContain('Total Data')
    expect(html).toContain('Remaining')
  })

  it('hides the data rows but keeps the expiry row when no snapshot exists', () => {
    const html = renderUsageSummary({
      dataUsedMB: 0,
      dataTotalMB: null,
      dataRemainingMB: null,
      expiresAt: new Date('2026-08-31T00:00:00.000Z'),
    })
    expect(html).toContain('Usage unavailable')
    expect(html).not.toContain('Data Used')
    expect(html).not.toContain('Total Data')
    expect(html).toContain('Expires')
  })

  it('marks the expiry as soon when within 7 days', () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    const html = renderUsageSummary({ dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512, expiresAt })
    expect(html).toContain('(soon)')
    expect(html).not.toContain('(expired)')
  })

  it('marks the package as expired when status is EXPIRED', () => {
    const html = renderUsageSummary({
      dataUsedMB: 512,
      dataTotalMB: 1024,
      dataRemainingMB: 512,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'EXPIRED',
    })
    expect(html).toContain('(expired)')
    expect(html).not.toContain('(soon)')
  })
})
