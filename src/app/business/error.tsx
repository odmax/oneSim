'use client'

import { useEffect } from 'react'

export default function BusinessError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Business portal error:', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm max-w-md">
        <p className="text-4xl">⚠️</p>
        <h2 className="mt-4 text-xl font-bold text-gray-900">Something went wrong</h2>
        <p className="mt-2 text-sm text-gray-500">
          We could not load this page. Please try again.
        </p>
        <button
          onClick={reset}
          className="mt-6 rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
