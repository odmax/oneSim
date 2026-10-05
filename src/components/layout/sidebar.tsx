'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Image from 'next/image'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Building2,
  Server,
  SlidersHorizontal,
  Boxes,
  Activity,
  GitBranch,
  History,
  Package,
  ClipboardList,
  Smartphone,
  BarChart3,
  FileText,
  PieChart,
  Wallet,
  LineChart,
  Signal,
  Radio,
  Bell,
  MonitorCheck,
  Gauge,
  HeartPulse,
  LifeBuoy,
  ScrollText,
  Terminal,
  Webhook,
  Users,
  Settings,
  UserCog,
  ShoppingCart,
  KeyRound,
  FileCode,
  List,
  Download,
  Circle,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

/**
 * Presentation-only href → icon mapping. Navigation items, hrefs, visibility
 * and read-only behaviour remain sourced entirely from the layouts.
 */
const ICON_BY_HREF: Record<string, LucideIcon> = {
  // Admin
  '/admin/dashboard': LayoutDashboard,
  '/admin/businesses': Building2,
  '/admin/providers': Server,
  '/admin/package-rules': SlidersHorizontal,
  '/admin/provider-catalog': Boxes,
  '/admin/provider-catalog/health': Activity,
  '/admin/provider-catalog/pipeline': GitBranch,
  '/admin/provider-catalog/history': History,
  '/admin/packages': Package,
  '/admin/orders': ClipboardList,
  '/admin/esims': Smartphone,
  '/admin/usage': BarChart3,
  '/admin/invoices': FileText,
  '/admin/finance': PieChart,
  '/admin/wallet-topups': Wallet,
  '/admin/analytics': LineChart,
  '/admin/analytics/sim-usage': Signal,
  '/admin/api-analytics': Radio,
  '/admin/alerts': Bell,
  '/admin/monitoring': MonitorCheck,
  '/admin/performance': Gauge,
  '/admin/provider-health': HeartPulse,
  '/admin/support': LifeBuoy,
  '/admin/audit-logs': ScrollText,
  '/admin/api-logs': Terminal,
  '/admin/provider-webhooks': Webhook,
  '/admin/webhook-monitoring': Webhook,
  '/admin/users': Users,
  '/admin/settings': Settings,
  '/admin/account': UserCog,
  // Business
  '/business/dashboard': LayoutDashboard,
  '/business/buy-esim': ShoppingCart,
  '/business/esims': Smartphone,
  '/business/esim-usage': BarChart3,
  '/business/orders': FileText,
  '/business/wallet': Wallet,
  '/business/support': LifeBuoy,
  '/business/api-keys': KeyRound,
  '/business/developers': FileCode,
  '/business/developers/template': FileText,
  '/business/api-analytics': BarChart3,
  '/business/api-usage': List,
  '/business/webhooks': Webhook,
  '/business/sku-downloads': Download,
  '/business/users': Users,
  '/business/account': Settings,
}

function SidebarContent({ items, portalName, activeHref, onNavigate }: { items: Array<SidebarItem>; portalName: string; activeHref: string | null; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-navy text-navy-foreground">
      <div className="flex items-center border-b border-white/10 px-5 py-5">
        <Image
          src="/brand/onesim-logo-white.svg"
          alt="OneSIM Logo"
          width={132}
          height={28}
          className="h-7 w-auto object-contain"
          priority
        />
      </div>

      <div className="border-b border-white/10 px-5 py-3">
        <p className="truncate text-[11px] font-medium uppercase tracking-wider text-slate-400">{portalName}</p>
      </div>

      <nav aria-label="Sidebar" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {items.map((item) => {
          if (item.sectionHeader) {
            return (
              <div
                key={item.title}
                className="mt-4 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500 first:mt-1"
              >
                {item.title}
              </div>
            )
          }

          const isActive = activeHref === item.href
          const Icon = ICON_BY_HREF[item.href] ?? Circle

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-disabled={item.readOnly ? true : undefined}
              aria-current={isActive && !item.readOnly ? 'page' : undefined}
              tabIndex={item.readOnly ? -1 : undefined}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                isActive && !item.readOnly
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-slate-300 hover:bg-white/5 hover:text-white',
                item.readOnly && 'cursor-not-allowed opacity-50'
              )}
              onClick={(e) => {
                if (item.readOnly) {
                  e.preventDefault()
                  return
                }
                onNavigate?.()
              }}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.title}</span>
              {item.readOnly && (
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-slate-400">Read-only</span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-white/10 p-3">
        <button
          type="button"
          onClick={() => {
            import('next-auth/react').then((mod) => mod.signOut({ callbackUrl: '/login' }))
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
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
        aria-expanded={open}
        aria-controls="mobile-sidebar"
        className="fixed left-3 top-3 z-40 rounded-lg bg-navy p-2 text-white shadow-lg transition-colors hover:bg-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            id="mobile-sidebar"
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl animate-in slide-in-from-left duration-200"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation menu"
              className="absolute right-3 top-3 z-10 rounded-md bg-white/10 p-1.5 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X className="h-5 w-5" />
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
