import Link from 'next/link'
import {
  Building2,
  Smartphone,
  ClipboardList,
  Wallet,
  Package,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { SectionCard } from '@/components/ui/section-card'
import { EmptyState } from '@/components/ui/empty-state'

export interface AdminDashboardBusiness {
  id: string
  name: string
  country: string | null
  status: string
  createdAt: Date
}

export interface AdminDashboardViewProps {
  businessCount: number
  esimCount: number
  orderCount: number
  /** Pre-formatted revenue string from the existing aggregate (no recalculation). */
  revenueFormatted: string
  pendingCount: number
  recentBusinesses: AdminDashboardBusiness[]
  errorMessage?: string
  successMessage?: string
}

const QUICK_ACTIONS = [
  { title: 'Manage Businesses', description: 'Approve, suspend and manage accounts', href: '/admin/businesses', icon: Building2 },
  { title: 'Product Catalog', description: 'Manage customer-facing eSIM products', href: '/admin/packages', icon: Package },
  { title: 'View All Orders', description: 'Monitor eSIM purchases across businesses', href: '/admin/orders', icon: ClipboardList },
  { title: 'Monitor eSIMs', description: 'Track provisioned eSIMs and their status', href: '/admin/esims', icon: Smartphone },
]

export function AdminDashboardView({
  businessCount,
  esimCount,
  orderCount,
  revenueFormatted,
  pendingCount,
  recentBusinesses,
  errorMessage,
  successMessage,
}: AdminDashboardViewProps) {
  const scaleMax = Math.max(esimCount, orderCount, businessCount, 1)
  const scaleRows = [
    { label: 'eSIMs', value: esimCount, bar: 'bg-primary' },
    { label: 'Orders', value: orderCount, bar: 'bg-success' },
    { label: 'Businesses', value: businessCount, bar: 'bg-navy' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="OneSIM Admin"
        title="Travel eSIM Overview"
        description="Monitor your travel eSIM business, orders and platform activity."
      />

      {errorMessage && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
          {successMessage}
        </div>
      )}

      {/* KPI row — values come only from the existing dashboard queries */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total eSIMs" value={esimCount} icon={Smartphone} accent="blue" />
        <StatCard label="Total Orders" value={orderCount} icon={ClipboardList} accent="navy" />
        <StatCard
          label="Total Businesses"
          value={businessCount}
          icon={Building2}
          accent="green"
          helper={pendingCount > 0 ? `${pendingCount} pending approval${pendingCount === 1 ? '' : 's'}` : 'No pending approvals'}
        />
        <StatCard label="Revenue" value={`$${revenueFormatted}`} icon={Wallet} accent="slate" helper="Qualifying orders" />
      </div>

      {/* Operational overview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Platform Snapshot"
          description="Relative scale of current platform totals."
        >
          <div className="space-y-4">
            {scaleRows.map((row) => (
              <div key={row.label}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{row.label}</span>
                  <span className="tabular-nums text-muted-foreground">{row.value.toLocaleString()}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${row.bar}`}
                    style={{ width: `${Math.max((row.value / scaleMax) * 100, row.value > 0 ? 4 : 0)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Bars compare current total magnitudes only and are not a time series.
          </p>
        </SectionCard>

        <SectionCard title="Admin Attention" description="Items that may need review.">
          {pendingCount > 0 ? (
            <div>
              <div className="flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/15 text-warning">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-2xl font-semibold tabular-nums text-foreground">{pendingCount}</p>
                  <p className="text-xs text-muted-foreground">Pending business approval{pendingCount === 1 ? '' : 's'}</p>
                </div>
              </div>
              <Link
                href="/admin/businesses"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Review businesses <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-success/20 bg-success/10 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-foreground">No pending approvals</p>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recent businesses */}
      <SectionCard
        title="Recent Businesses"
        description="The five most recently created business accounts."
        actions={
          <Link
            href="/admin/businesses"
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
        bodyClassName="p-0"
      >
        {recentBusinesses.length === 0 ? (
          <EmptyState
            className="m-5 border-0 bg-transparent"
            icon={<Building2 className="h-5 w-5" />}
            title="No businesses yet"
            description="Newly created business accounts will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Business</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Country</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Created</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {recentBusinesses.map((business) => (
                  <tr key={business.id} className="border-b border-border/70 last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/businesses/${business.id}`}
                        className="font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {business.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{business.country || '—'}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={business.status} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{new Date(business.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/businesses/${business.id}`}
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

      {/* Quick actions */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-card transition-all hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <action.icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{action.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{action.description}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
