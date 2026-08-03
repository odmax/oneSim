import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { EsimActionsBar } from './EsimActionsBar'
import type { EsimActionAvailability, EsimActionState } from '@/lib/providers/capabilities/esim-action-availability'

function state(over: Partial<EsimActionState> = {}): EsimActionState {
  return { visible: false, enabled: false, ...over }
}

function availability(over: Partial<EsimActionAvailability> = {}): EsimActionAvailability {
  return {
    refreshStatus: state({ visible: true, enabled: true }),
    refreshUsage: state({ visible: true, enabled: true }),
    qrCode: state({ visible: true, enabled: true }),
    suspend: state({ visible: true, enabled: true }),
    resume: state({ visible: true, enabled: true }),
    topUp: state({ visible: true, enabled: true }),
    isChoiceProvider: false,
    ...over,
  }
}

function renderBar(props: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(EsimActionsBar as any, {
      availability: availability(),
      topUpHref: '/admin/esims/e1/top-up',
      refreshStatusAction: vi.fn(),
      refreshUsageAction: vi.fn(),
      qrCodeAction: vi.fn(),
      suspendAction: vi.fn(),
      resumeAction: vi.fn(),
      ...props,
    }),
  )
}

function buttonAttrs(html: string, label: string) {
  const match = html.match(new RegExp(`<button([^>]*)>${label}</button>`))
  return match ? match[1] : ''
}

const CHOICE_WARNING = 'Choice may delete an unused bundle when it is suspended. Continue?'

describe('EsimActionsBar', () => {
  it('renders enabled Refresh Status / Refresh Usage / QR / Suspend / Resume for a capable provider', () => {
    const html = renderBar({ availability: availability() })
    expect(html).toContain('Refresh Status')
    expect(html).toContain('Refresh Usage')
    expect(html).toContain('Get QR Code')
    expect(html).toContain('Suspend eSIM')
    expect(html).toContain('Resume eSIM')
    expect(buttonAttrs(html, 'Refresh Status')).not.toContain('disabled=""')
  })

  it('does not render Refresh Status when STATUS capability is missing', () => {
    const html = renderBar({ availability: availability({ refreshStatus: state() }) })
    expect(html).not.toContain('Refresh Status')
  })

  it('does not render Refresh Usage for providers without the USAGE capability', () => {
    const html = renderBar({ availability: availability({ refreshUsage: state() }) })
    expect(html).not.toContain('Refresh Usage')
  })

  it('does not render Suspend eSIM when the provider does not declare SUSPEND', () => {
    const html = renderBar({ availability: availability({ suspend: state() }) })
    expect(html).not.toContain('Suspend eSIM')
  })

  it('does not render Resume eSIM when the provider does not declare RESUME', () => {
    const html = renderBar({ availability: availability({ resume: state() }) })
    expect(html).not.toContain('Resume eSIM')
  })

  it('disables an action and exposes the reason via disabled, aria-disabled, title, and visible text', () => {
    const html = renderBar({
      availability: availability({
        refreshStatus: state({ visible: true, enabled: false, reason: 'Provider identifier unavailable.' }),
      }),
    })
    const attrs = buttonAttrs(html, 'Refresh Status')
    expect(attrs).toContain('disabled=""')
    expect(attrs).toContain('aria-disabled="true"')
    expect(attrs).toContain('title="Provider identifier unavailable."')
    expect(html).toContain('Provider identifier unavailable.')
  })

  it('disables Get QR Code with a Choice data note when Choice has no stored activation data', () => {
    const html = renderBar({
      availability: availability({
        qrCode: state({ visible: true, enabled: false, reason: 'Choice did not return QR activation data for this eSIM.' }),
      }),
    })
    expect(html).toContain('Choice did not return QR activation data for this eSIM.')
    expect(buttonAttrs(html, 'Get QR Code')).toContain('disabled=""')
  })

  it('keeps Get QR Code enabled when stored activation data exists', () => {
    const html = renderBar({ availability: availability({ qrCode: state({ visible: true, enabled: true }) }) })
    expect(buttonAttrs(html, 'Get QR Code')).not.toContain('disabled=""')
  })

  it('disables Suspend eSIM for EXPIRED with a status reason', () => {
    const html = renderBar({
      availability: availability({
        suspend: state({ visible: true, enabled: false, reason: 'Suspend is not available for EXPIRED status.' }),
      }),
    })
    expect(buttonAttrs(html, 'Suspend eSIM')).toContain('disabled=""')
    expect(html).toContain('Suspend is not available for EXPIRED status.')
  })

  it('disables Resume eSIM for ACTIVE with a status reason', () => {
    const html = renderBar({
      availability: availability({
        resume: state({ visible: true, enabled: false, reason: 'Resume is only available for suspended eSIMs.' }),
      }),
    })
    expect(buttonAttrs(html, 'Resume eSIM')).toContain('disabled=""')
    expect(html).toContain('Resume is only available for suspended eSIMs.')
  })

  it('enables Resume eSIM for SUSPENDED', () => {
    const html = renderBar({ availability: availability({ resume: state({ visible: true, enabled: true }) }) })
    expect(buttonAttrs(html, 'Resume eSIM')).not.toContain('disabled=""')
  })

  it('shows the Choice suspend warning only for Choice providers', () => {
    const choice = renderBar({ availability: availability({ isChoiceProvider: true, suspend: state({ visible: true, enabled: true }) }) })
    expect(choice).toContain(CHOICE_WARNING)

    const other = renderBar({ availability: availability({ isChoiceProvider: false }) })
    expect(other).not.toContain(CHOICE_WARNING)
  })

  it('renders Top Up as a link when enabled', () => {
    const html = renderBar({ availability: availability({ topUp: state({ visible: true, enabled: true }) }) })
    expect(html).toContain('href="/admin/esims/e1/top-up"')
    expect(html).toContain('Top Up')
  })

  it('renders Top Up as a disabled control when the provider blocks it', () => {
    const html = renderBar({
      availability: availability({ topUp: state({ visible: true, enabled: false, reason: 'Top up is disabled for this provider.' }) }),
    })
    expect(html).not.toContain('href="/admin/esims/e1/top-up"')
    expect(buttonAttrs(html, 'Top Up')).toContain('disabled=""')
    expect(html).toContain('Top up is disabled for this provider.')
  })

  it('hides Top Up entirely when the provider does not declare TOP_UP', () => {
    const html = renderBar({ availability: availability({ topUp: state() }) })
    expect(html).not.toContain('Top Up')
  })

  it('shows a neutral empty state when no action is available', () => {
    const html = renderBar({
      availability: availability({
        refreshStatus: state(),
        refreshUsage: state(),
        qrCode: state(),
        suspend: state(),
        resume: state(),
        topUp: state(),
      }),
    })
    expect(html).toContain('No provider actions are available for this eSIM.')
    expect(html).not.toContain('Refresh Status')
    expect(html).not.toContain('Suspend eSIM')
  })
})
