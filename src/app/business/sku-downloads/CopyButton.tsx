'use client'

export function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <button onClick={() => navigator.clipboard?.writeText(text)}
      className="text-emerald-600 hover:text-emerald-700 font-medium">
      {label || 'Copy'}
    </button>
  )
}
