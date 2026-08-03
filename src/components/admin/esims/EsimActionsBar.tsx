'use client'

import type { FormEvent } from 'react'
import Link from 'next/link'
import type { EsimActionAvailability, EsimActionState } from '@/lib/providers/capabilities/esim-action-availability'

export const CHOICE_SUSPEND_WARNING = 'Choice may delete an unused bundle when it is suspended. Continue?'

interface EsimActionsBarProps {
  availability: EsimActionAvailability
  topUpHref?: string | null
  refreshStatusAction: (formData: FormData) => void | Promise<void>
  refreshUsageAction: (formData: FormData) => void | Promise<void>
  qrCodeAction: (formData: FormData) => void | Promise<void>
  suspendAction: (formData: FormData) => void | Promise<void>
  resumeAction: (formData: FormData) => void | Promise<void>
}

function buttonClasses(state: EsimActionState, className: string) {
  return `rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${className}`
}

function ActionForm({ state, label, className, action, onSubmit }: {
  state: EsimActionState
  label: string
  className: string
  action: (formData: FormData) => void | Promise<void>
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void
}) {
  if (!state.visible) return null
  return (
    <form action={action} onSubmit={onSubmit}>
      <div className="flex flex-col items-start gap-1">
        <button
          type="submit"
          disabled={!state.enabled}
          aria-disabled={!state.enabled}
          title={state.reason}
          className={buttonClasses(state, className)}
        >
          {label}
        </button>
        {!state.enabled && state.reason && (
          <span className="max-w-[240px] text-xs text-gray-400">{state.reason}</span>
        )}
      </div>
    </form>
  )
}

function TopUpAction({ state, href }: { state: EsimActionState; href: string }) {
  if (!state.visible) return null
  const className = 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
  if (state.enabled) {
    return (
      <Link href={href} className={buttonClasses(state, className)}>
        Top Up
      </Link>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" disabled aria-disabled title={state.reason} className={buttonClasses(state, className)}>
        Top Up
      </button>
      {state.reason && <span className="max-w-[240px] text-xs text-gray-400">{state.reason}</span>}
    </div>
  )
}

/**
 * Admin eSIM provider actions bar. Rendering and enablement come entirely from
 * the central `getEsimActionAvailability` result — no visibility logic is
 * duplicated here. Disabled actions expose their reason as text + title +
 * aria-disabled. The suspend confirmation warning is Choice-only.
 */
export function EsimActionsBar({
  availability,
  topUpHref,
  refreshStatusAction,
  refreshUsageAction,
  qrCodeAction,
  suspendAction,
  resumeAction,
}: EsimActionsBarProps) {
  const actionStates = [
    availability.refreshStatus,
    availability.refreshUsage,
    availability.qrCode,
    availability.suspend,
    availability.resume,
    availability.topUp,
  ]
  const hasAnyVisible = actionStates.some((a) => a.visible)

  return (
    <div>
      <div className="flex flex-wrap items-start gap-3">
        <ActionForm state={availability.refreshStatus} label="Refresh Status" className="border-cyan-300 text-cyan-700 hover:bg-cyan-50" action={refreshStatusAction} />
        <ActionForm state={availability.refreshUsage} label="Refresh Usage" className="border-gray-300 text-gray-700 hover:bg-gray-50" action={refreshUsageAction} />
        <ActionForm state={availability.qrCode} label="Get QR Code" className="border-purple-300 text-purple-700 hover:bg-purple-50" action={qrCodeAction} />
        <ActionForm
          state={availability.suspend}
          label="Suspend eSIM"
          className="border-orange-300 text-orange-700 hover:bg-orange-50"
          action={suspendAction}
          onSubmit={(e) => {
            if (availability.isChoiceProvider && !window.confirm(CHOICE_SUSPEND_WARNING)) e.preventDefault()
          }}
        />
        <ActionForm state={availability.resume} label="Resume eSIM" className="border-green-300 text-green-700 hover:bg-green-50" action={resumeAction} />
        <TopUpAction state={availability.topUp} href={topUpHref || ''} />
      </div>
      {availability.isChoiceProvider && availability.suspend.visible && (
        <p className="mt-3 w-full text-xs text-amber-600">{CHOICE_SUSPEND_WARNING}</p>
      )}
      {!hasAnyVisible && <p className="text-sm text-gray-400">No provider actions are available for this eSIM.</p>}
    </div>
  )
}
