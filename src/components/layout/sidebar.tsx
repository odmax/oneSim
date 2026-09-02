'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Image from 'next/image'

interface SidebarItem {
  title: string
  href: string
  icon?: any
  readOnly?: boolean
  sectionHeader?: boolean
}

interface SidebarProps {
  items: Array<SidebarItem>
  portalName: string
}

function SidebarContent({ items, portalName, activeHref, onNavigate }: { items: Array<SidebarItem>; portalName: string; activeHref: string | null; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      <div className="flex flex-col items-center border-b border-gray-800 px-6 py-8">
        <Image
          src="/brand/onesim-logo-white.svg"
          alt="OneSIM Logo"
          width={130}
          height={28}
          className="object-contain"
          priority
        />
        <p className="mt-4 text-xs font-medium text-gray-400 tracking-wider uppercase">{portalName}</p>
      </div>

      <nav aria-label="Sidebar" className="flex-1 space-y-1 overflow-y-auto p-4">
        {items.map((item) => {
          if (item.sectionHeader) {
            return (
              <div
                key={item.title}
                className="px-1 pt-4 pb-1 text-[10px] font-semibold tracking-widest text-gray-500 uppercase"
              >
                {item.title}
              </div>
            )
          }

          const isActive = activeHref === item.href

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-disabled={item.readOnly ? true : undefined}
              tabIndex={item.readOnly ? -1 : undefined}
              className={`sidebar-item block ${
                isActive && !item.readOnly ? 'active text-white' : 'text-gray-300 hover:text-white'
              } ${item.readOnly ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={(e) => {
                if (item.readOnly) {
                  e.preventDefault()
                  return
                }
                onNavigate?.()
              }}
            >
              <span>{item.title}</span>
              {item.readOnly && <span className="ml-auto text-xs">(Read-only)</span>}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-gray-800 p-4">
        <button
          onClick={() => {
            import('next-auth/react').then((mod) => mod.signOut({ callbackUrl: '/login' }))
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/10 transition-all"
        >
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  )
}

export default function Sidebar({ items, portalName }: SidebarProps) {
  const pathname = usePathname()
  const [activeHref, setActiveHref] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setActiveHref(pathname)
  }, [pathname])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <>
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        className="fixed left-3 top-3 z-40 rounded-md bg-[#1a1a2e] p-2 text-white md:hidden"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation menu"
              className="absolute right-3 top-3 z-10 rounded-md bg-white/10 p-1.5 text-white"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <SidebarContent items={items} portalName={portalName} activeHref={activeHref} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden h-screen w-64 shrink-0 md:block">
        <SidebarContent items={items} portalName={portalName} activeHref={activeHref} />
      </div>
    </>
  )
}
