'use client'

const CHOICE_SUSPEND_WARNING = 'Choice may delete an unused bundle when it is suspended. Continue?'

const CAN_SUSPEND_STATUSES = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']

/**
 * Admin eSIM suspend/resume actions.
 * Suspend is enabled for in-use statuses only; resume is enabled only for
 * SUSPENDED. For Choice providers the suspend submit is guarded by a
 * confirmation warning (an unused bundle may be deleted when suspended).
 */
export function EsimLifecycleActions({ status, isChoiceProvider, suspendAction, resumeAction }: {
  status: string
  isChoiceProvider: boolean
  suspendAction: (formData: FormData) => void
  resumeAction: (formData: FormData) => void
}) {
  const canSuspend = CAN_SUSPEND_STATUSES.includes(status)
  const canResume = status === 'SUSPENDED'

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form
        action={suspendAction}
        onSubmit={(e) => {
          if (isChoiceProvider && !confirm(CHOICE_SUSPEND_WARNING)) e.preventDefault()
        }}
      >
        <button
          type="submit"
          disabled={!canSuspend}
          className="rounded-lg border border-orange-300 px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Suspend eSIM
        </button>
      </form>
      {isChoiceProvider && (
        <p className="w-full text-xs text-amber-600">Choice may delete an unused bundle when it is suspended. Continue?</p>
      )}
      <form action={resumeAction}>
        <button
          type="submit"
          disabled={!canResume}
          className="rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Resume eSIM
        </button>
      </form>
    </div>
  )
}
