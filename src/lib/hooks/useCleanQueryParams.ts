'use client'

import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'

const FLASH_PARAMS = ['synced', 'updated', 'authenticated', 'error', 'success', 'setup', 'preview', 'run']

export function useCleanQueryParams() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const cleaned = useRef(false)

  useEffect(() => {
    if (cleaned.current) return

    const params = new URLSearchParams(searchParams.toString())
    let hasFlash = false

    for (const key of FLASH_PARAMS) {
      if (params.has(key)) {
        params.delete(key)
        hasFlash = true
      }
    }

    if (hasFlash) {
      cleaned.current = true
      const qs = params.toString()
      const cleanUrl = pathname + (qs ? `?${qs}` : '')
      router.replace(cleanUrl, { scroll: false })
    }
  }, [pathname, searchParams, router])
}
