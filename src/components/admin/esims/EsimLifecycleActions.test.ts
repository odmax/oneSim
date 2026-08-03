import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { EsimLifecycleActions } from './EsimLifecycleActions'

function renderActions(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(EsimLifecycleActions as any, { suspendAction: vi.fn(), resumeAction: vi.fn(), ...props }))
}

function buttonAttrs(html: string, label: string) {
  const match = html.match(new RegExp(`<button([^>]*)>${label}</button>`))
  return match ? match[1] : ''
}

const CHOICE_WARNING = 'Choice may delete an unused bundle when it is suspended. Continue?'

describe('EsimLifecycleActions', () => {
  it('shows the Choice suspend warning for Choice providers', () => {
    const html = renderActions({ status: 'ACTIVE', isChoiceProvider: true })
    expect(html).toContain(CHOICE_WARNING)
  })

  it('hides the Choice suspend warning for non-Choice providers', () => {
    const html = renderActions({ status: 'ACTIVE', isChoiceProvider: false })
    expect(html).not.toContain(CHOICE_WARNING)
  })

  it('enables suspend for in-use statuses', () => {
    for (const status of ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']) {
      const html = renderActions({ status, isChoiceProvider: false })
      expect(html).toContain('Suspend eSIM')
      expect(buttonAttrs(html, 'Suspend eSIM')).not.toContain('disabled=""')
    }
  })

  it('disables suspend for SUSPENDED, EXPIRED, FAILED, and CANCELLED', () => {
    for (const status of ['SUSPENDED', 'EXPIRED', 'FAILED', 'CANCELLED']) {
      const html = renderActions({ status, isChoiceProvider: false })
      expect(html).toContain('Suspend eSIM')
      expect(buttonAttrs(html, 'Suspend eSIM')).toContain('disabled=""')
    }
  })

  it('enables resume only when status is SUSPENDED', () => {
    const suspended = renderActions({ status: 'SUSPENDED', isChoiceProvider: false })
    expect(suspended).toContain('Resume eSIM')
    expect(buttonAttrs(suspended, 'Resume eSIM')).not.toContain('disabled=""')

    const active = renderActions({ status: 'ACTIVE', isChoiceProvider: false })
    expect(active).toContain('Resume eSIM')
    expect(buttonAttrs(active, 'Resume eSIM')).toContain('disabled=""')
  })
})
