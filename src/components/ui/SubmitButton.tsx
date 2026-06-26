'use client'

export function SubmitButton({ children, loading, loadingText, disabled, onClick, className, variant = 'primary' }: {
  children: React.ReactNode
  loading?: boolean
  loadingText?: string
  disabled?: boolean
  onClick?: () => void
  className?: string
  variant?: 'primary' | 'danger' | 'outline'
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm'
  const colors = {
    primary: 'bg-cyan-600 text-white hover:bg-cyan-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    outline: 'border border-gray-300 text-gray-700 hover:bg-gray-50 bg-white',
  }

  return (
    <button type="submit" onClick={onClick} disabled={disabled || loading}
      className={`${base} ${colors[variant]} ${className || ''}`}>
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {loading && loadingText ? loadingText : children}
    </button>
  )
}

export function FormStatusMessage({ message, type }: { message: string | null; type: 'success' | 'error' | null }) {
  if (!message) return null
  const colors = type === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${colors}`}>
      {type === 'success' ? '✓ ' : '⚠ '}{message}
    </div>
  )
}
