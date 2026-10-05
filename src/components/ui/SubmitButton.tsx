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
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed'
  const colors = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    outline: 'border border-input text-foreground hover:bg-accent hover:text-accent-foreground bg-background',
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
  const colors = type === 'success'
    ? 'bg-success/10 text-success border-success/20'
    : 'bg-destructive/10 text-destructive border-destructive/20'
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${colors}`}>
      {type === 'success' ? '✓ ' : '⚠ '}{message}
    </div>
  )
}
