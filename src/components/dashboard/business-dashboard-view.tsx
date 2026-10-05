import Link from 'next/link'
import {
  Wallet,
  Smartphone,
  ClipboardList,
  BarChart3,
  ShoppingCart,
  FileText,
  Users,
  Globe,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { SectionCard } from '@/components/ui/section-card'
import { EmptyState } from '@/components/ui/empty-state'

export interface BusinessRecentOrder {
  id: string
  packageName: string
  dataGB: number
  validityDays: number
  quantity: number
  amountFormatted: string
  status: string
  createdAt: Date
}

export interface BusinessDashboardViewProps {
  firstName?: string
  businessName?: string | null
  isMember: boolean
  walletFormatted: string
  esimCount: number
  orderCount: number
  recentOrders: BusinessRecentOrder[]
}

export function BusinessDashboardView({
  firstName,
  businessName,
  isMember,
  walletFormatted,
  esimCount,
  orderCount,
  recentOrders,
}: BusinessDashboardViewProps) {
  const quickActions = [
    { title: 'Buy eSIMs', description: 'Purchase new eSIM packages for your team', href: '/business/buy-esim', icon: ShoppingCart, restricted: isMember },
    { title: 'View eSIMs', description: 'Manage your eSIMs and QR codes', href: '/business/esims', icon: Smartphone, restricted: false },
    { title: 'Orders & Invoices', description: 'Track your orders and download invoices', href: '/business/orders', icon: FileText, restricted: isMember },
    { title: 'Team Management', description: 'Invite and manage team members', href: '/business/users', icon: Users, restricted: isMember },
    { title: 'Top Up Wallet', description: 'Add funds to your wallet for quick purchases', href: '/business/wallet', icon: Wallet, restricted: isMember },
    { title: 'Usage Analytics', description: 'Monitor data usage across all eSIMs', href: '/business/usage', icon: BarChart3, restricted: false },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={businessName || 'OneSIM Travel eSIM'}
        title="Your eSIM Dashboard"
        description={`Welcome back${firstName ? `, ${firstName}` : ''}. Manage your travel eSIMs, orders and connectivity.`}
        actions={
          !isMember ? (
            <Link
              href="/business/buy-esim"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <ShoppingCart className="h-4 w-4" /> Buy eSIM
            </Link>
          ) : undefined
        }
      />

      {/* KPI row — all values come from the existing dashboard queries */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet Balance" value={`$${walletFormatted}`} icon={Wallet} accent="green" helper="Available credit" />
        <StatCard label="Total eSIMs" value={esimCount} icon={Smartphone} accent="blue" helper="eSIMs in your account" />
        <StatCard label="Total Orders" value={orderCount} icon={ClipboardList} accent="navy" helper="All eSIM purchases" />
        <StatCard label="Data Used" value="—" icon={BarChart3} accent="amber" helper="Available in eSIM Usage" />
      </div>

      {/* Travel / connectivity hero — product navigation, no invented metrics */}
      <section className="relative overflow-hidden rounded-xl border border-border bg-navy p-6 text-navy-foreground shadow-card">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white">
              <Globe className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">Stay connected worldwide</h2>
              <p className="mt-1 max-w-xl text-sm text-slate-300">
                Manage international travel eSIMs for your team — purchase data plans, assign connectivity and track
                every eSIM from one place.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isMember && (
              <Link
                href="/business/buy-esim"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <ShoppingCart className="h-4 w-4" /> Buy eSIM
              </Link>
            )}
            <Link
              href="/business/esims"
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              View eSIMs
            </Link>
          </div>
        </div>
      </section>

      {/* Recent eSIM orders */}
      <SectionCard
        title="Recent eSIM Orders"
        description="Your five most recent eSIM purchases."
        actions={
          <Link
            href="/business/orders"
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            View all orders <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
        bodyClassName="p-0"
      >
        {recentOrders.length === 0 ? (
          <EmptyState
            className="m-5 border-0 bg-transparent"
            icon={<ShoppingCart className="h-5 w-5" />}
            title="No orders yet"
            description="Your recent eSIM purchases will appear here."
            action={
              !isMember ? (
                <Link
                  href="/business/buy-esim"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <ShoppingCart className="h-4 w-4" /> Buy eSIM
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Package</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Allowance</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Qty</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id} className="border-b border-border/70 last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-3">
                      <span className="font-medium text-foreground">{order.packageName}</span>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {order.dataGB} GB · {order.validityDays} days
                    </td>
                    <td className="px-5 py-3 tabular-nums text-muted-foreground">{order.quantity}</td>
                    <td className="px-5 py-3 font-semibold tabular-nums text-foreground">${order.amountFormatted}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{new Date(order.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/business/orders/${order.id}`}
                        className="text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Quick actions — MEMBER read-only behaviour preserved */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Quick Actions</h2>
          {isMember && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> Read-only access
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {quickActions.map((action) =>
            action.restricted ? (
              <div
                key={action.href}
                aria-disabled="true"
                className="cursor-not-allowed select-none rounded-xl border border-border bg-card p-4 opacity-60 shadow-card"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <action.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">{action.title}</h3>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Read-only</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{action.description}</p>
                  </div>
                </div>
              </div>
            ) : (
              <Link
                key={action.href}
                href={action.href}
                className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-card transition-all hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                  <action.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">{action.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{action.description}</span>
                </span>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
              </Link>
            )
          )}
        </div>
        {isMember && (
          <div className="mt-4 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3">
            <p className="text-sm text-foreground">
              <span className="font-medium">Note:</span> Business Members have read-only access. Contact your Business Admin for full access.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
