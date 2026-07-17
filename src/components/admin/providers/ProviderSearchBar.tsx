'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

export function ProviderSearchBar() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialValue = searchParams.get('search') || ''
  const [value, setValue] = useState(initialValue)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setValue(searchParams.get('search') || '')
  }, [searchParams])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (v) {
        params.set('search', v)
      } else {
        params.delete('search')
      }
      router.push(`/admin/providers?${params.toString()}`)
    }, 300)
  }, [router, searchParams])

  return (
    <input
      type="text"
      value={value}
      onChange={handleChange}
      placeholder="Search by name, code, strategy, or status..."
      className="w-full max-w-md rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
    />
  )
}
