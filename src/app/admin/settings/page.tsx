import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

function SectionCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
      <div className="mb-5">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      {children}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2.5">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function StatBox({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color || 'text-gray-900'}`}>{value}</p>
    </div>
  )
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${color}`}>{children}</span>
}

export default async function AdminSettingsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const [
    settings,
    providerCount,
    activeProviderCount,
    lastSyncProvider,
    adminUserCount,
    auditLogCount,
    apiKeyCount,
    pricingRuleCount,
    pendingJobs,
    failedJobs,
  ] = await Promise.all([
    prisma.setting.findMany({ orderBy: { key: 'asc' } }),
    // annual markup — deprecated
    prisma.provider.count(),
    prisma.provider.count({ where: { status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] } } }),
    prisma.provider.findFirst({ orderBy: { lastSyncAt: 'desc' }, select: { name: true, lastSyncAt: true } }),
    prisma.user.count({ where: { role: 'INTERNAL_ADMIN', isActive: true } }),
    prisma.auditLog.count(),
    prisma.businessApiKey.count({ where: { status: 'ACTIVE' } }),
    prisma.pricingRule.count({ where: { isActive: true } }),
    prisma.backgroundJob.count({ where: { status: 'PENDING' } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED' } }),
  ])

  const getSetting = (key: string) => settings.find(s => s.key === key)?.value
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const appEnv = process.env.NODE_ENV || 'development'
  const cronSecretConfigured = !!(process.env.CRON_SECRET || getSetting('cron_secret'))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
        <p className="mt-1 text-sm text-gray-500">Platform configuration for OneSim</p>
      </div>

      {/* Summary row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatBox label="Environment" value={appEnv === 'production' ? 'Production' : appEnv === 'development' ? 'Development' : appEnv} />
        <StatBox label="Database" value={<span className="text-emerald-600">Connected</span>} />
        <StatBox label="Active Providers" value={<span className="text-emerald-600">{activeProviderCount}</span>} />
        <StatBox label="Admin Users" value={adminUserCount} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">

        {/* 1. Platform Profile */}
        <SectionCard title="Platform Profile" description="General platform identity and contact information">
          <div className="space-y-3">
            <Field label="Platform Name" value="OneSim" />
            <Field label="App URL" value={baseUrl} mono />
            <Field label="Support Email" value={getSetting('support_email') || 'Not configured'} />
            <Field label="Environment" value={appEnv === 'production' ? 'Production' : appEnv === 'development' ? 'Development' : appEnv} />
            <Field label="Default Timezone" value={getSetting('default_timezone') || 'UTC'} />
            <Field label="Default Currency" value={getSetting('default_currency') || 'USD'} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/admin/account" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Account Settings →</Link>
          </div>
        </SectionCard>

        {/* 2. Billing & Wallet */}
        <SectionCard title="Billing & Wallet" description="Invoice, pricing, and wallet configuration">
          <div className="space-y-3">
            <Field label="Default Currency" value={getSetting('default_currency') || 'USD'} />
            <Field label="Low Balance Threshold" value={getSetting('low_balance_threshold') || 'Not configured'} />
            <Field label="Invoice Prefix" value={getSetting('invoice_prefix') || 'INV-'} />
            <Field label="Active Pricing Rules" value={String(pricingRuleCount)} />
            <Field label="VAT / Tax" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
            <Field label="Payment Instructions" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/admin/invoices" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Invoices →</Link>
            <Link href="/admin/businesses" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Businesses →</Link>
            <Link href="/admin/pricing-rules" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Pricing Rules →</Link>
          </div>
        </SectionCard>

        {/* 3. Product & Pricing Defaults */}
        <SectionCard title="Product & Pricing Defaults" description="Default values for new packages and pricing">
          <div className="space-y-3">
            <Field label="Default Package Currency" value={getSetting('default_currency') || 'USD'} />
            <Field label="Default Activation" value={<Badge color="bg-gray-100 text-gray-500">Inactive</Badge>} />
            <Field label="Annual Markup" value={<Badge color="bg-gray-100 text-gray-500">Manual per product</Badge>} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/admin/packages" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Product Catalog →</Link>
            <Link href="/admin/provider-catalog" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Provider Catalog →</Link>
            <Link href="/admin/packages?tab=manual" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Manual Products →</Link>
            <Link href="/admin/pricing-rules" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Pricing Rules →</Link>
          </div>
        </SectionCard>

        {/* 4. API Settings */}
        <SectionCard title="API Settings" description="External API configuration for business clients">
          <div className="space-y-3">
            <Field label="Public API Base URL" value={`${baseUrl}/api/v1`} mono />
            <Field label="API Version" value="v1" />
            <Field label="API Key Prefix" value="onesim_" mono />
            <Field label="Idempotency-Key" value={<Badge color="bg-emerald-50 text-emerald-600">Supported</Badge>} />
            <Field label="Default Rate Limit" value="60 req / min" />
            <Field label="Active API Keys" value={String(apiKeyCount)} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/admin/api-logs" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">API Logs →</Link>
            <Link href="/business/developers" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Developer Docs →</Link>
          </div>
        </SectionCard>

        {/* 5. Provider Operations */}
        <SectionCard title="Provider Operations" description="Upstream provider communication status">
          <div className="space-y-3">
            <Field label="Total Providers" value={String(providerCount)} />
            <Field label="Active Providers" value={<span className="text-emerald-600 font-medium">{activeProviderCount}</span>} />
            <Field label="Last Provider Sync"
              value={lastSyncProvider?.lastSyncAt
                ? new Date(lastSyncProvider.lastSyncAt).toLocaleDateString()
                : 'Never'} />
            <Field label="Health Check Timeout" value="30s" />
            <Field label="Default Retry Count" value="3" />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/admin/providers" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Providers →</Link>
            <Link href="/admin/provider-templates" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Provider Templates →</Link>
          </div>
        </SectionCard>

        {/* 6. Security & Access */}
        <SectionCard title="Security & Access" description="Platform security overview and access management">
          <div className="space-y-3">
            <Field label="Active Admin Users" value={String(adminUserCount)} />
            <Field label="Active API Keys" value={String(apiKeyCount)} />
            <Field label="Audit Log Entries" value={String(auditLogCount)} />
            <Field label="Strong Passwords" value={<Badge color="bg-emerald-50 text-emerald-600">Enforced</Badge>} />
            <Field label="Session Timeout" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
            <Field label="API Key Rotation" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/admin/users" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Admin Users →</Link>
            <Link href="/admin/audit-logs" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Audit Logs →</Link>
            <Link href="/admin/api-logs" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">API Logs →</Link>
          </div>
        </SectionCard>

      </div>

      {/* 7. Notifications - full width */}
      <SectionCard title="Notifications" description="Alert and notification preferences">
        <div className="space-y-3">
          <Field label="Admin Support Email" value={getSetting('support_email') || 'Not configured'} />
          <Field label="Low Balance Alert" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
          <Field label="Activation Failure Alert" value={<Badge color="bg-gray-100 text-gray-500">Coming soon</Badge>} />
        </div>
      </SectionCard>

      {/* 8. Maintenance - full width */}
      <SectionCard title="Maintenance" description="Platform environment and background job status">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatBox label="Environment" value={appEnv === 'production' ? 'Production' : appEnv === 'development' ? 'Development' : appEnv} />
          <StatBox label="Database" value={<span className="text-emerald-600">Connected</span>} />
          <StatBox label="Cron Endpoint" value={
            cronSecretConfigured
              ? <span className="text-emerald-600">Configured</span>
              : <span className="text-amber-600">Not configured</span>
          } />
          <StatBox label="Pending Jobs" value={pendingJobs} />
        </div>
        {failedJobs > 0 && (
          <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3">
            <p className="text-sm text-amber-700"><span className="font-medium">{failedJobs}</span> failed background jobs.</p>
          </div>
        )}
        {cronSecretConfigured && (
          <div className="mt-4 rounded-lg bg-gray-50 p-3">
            <p className="text-xs text-gray-500">
              <span className="font-medium text-gray-700">Cron URL:</span>{' '}
              <code className="rounded bg-gray-100 px-1 font-mono">GET {baseUrl}/api/cron/process-jobs</code>
            </p>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href="/admin/usage" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Usage Analytics →</Link>
          <Link href="/admin/analytics" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Analytics →</Link>
        </div>
      </SectionCard>
    </div>
  )
}
