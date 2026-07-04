'use client'

import { deleteRule } from '@/lib/actions/package-rules'

export function DeleteRuleButton({ ruleId }: { ruleId: string }) {
  return (
    <form action={deleteRule.bind(null, ruleId)}>
      <button type="submit" className="text-xs text-red-500 hover:text-red-700"
        onClick={e => { if (!confirm('Delete this rule?')) e.preventDefault() }}>
        Delete
      </button>
    </form>
  )
}
