'use client'

import { signOut } from 'next-auth/react'

export default function AdminAccessDeniedSignOut() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="rounded-lg bg-cyan-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-cyan-700"
    >
      Sign out and sign in again
    </button>
  )
}