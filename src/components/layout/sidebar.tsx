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

export default function Sidebar({ items, portalName }: SidebarProps) {
  const pathname = usePathname()
  const [activeHref, setActiveHref] = useState<string | null>(null)

  // Defer active-class to after hydration so SSR HTML matches client first render
  useEffect(() => {
    setActiveHref(pathname)
  }, [pathname])

  return (
    <div className="flex h-screen w-64 flex-col bg-[#1a1a2e]">
      <div className="flex flex-col items-center border-b border-gray-800 px-6 py-8">
        <Image
          src="/brand/onesim-logo-white.svg"
          alt="OneSim Logo"
          width={130}
          height={28}
          className="object-contain"
          priority
        />
        <p className="mt-4 text-xs font-medium text-gray-400 tracking-wider uppercase">{portalName}</p>
      </div>
      
      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
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
              className={`sidebar-item ${
                isActive ? 'active text-white' : 'text-gray-300 hover:text-white'
              } ${item.readOnly ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={(e) => {
                if (item.readOnly) {
                  e.preventDefault()
                }
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
