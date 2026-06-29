'use client'

export function ProviderHealthCards({ provider }: { provider: any }) {
  const p = provider || {}
  const snap = (provider._healthSnapshot || {}) as any

  const cards = [
    { label: 'Status', value: p.status || '—' },
    { label: 'Environment', value: p.environment || '—' },
    { label: 'Certification', value: p.certificationStatus || '—' },
    { label: 'Last Auth', value: p.lastSuccessfulConnection ? new Date(p.lastSuccessfulConnection).toLocaleDateString() : '—' },
    { label: 'Last Sync', value: p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleDateString() : '—' },
    { label: 'Last Import', value: p.lastSyncResult?.includes('imported') ? new Date(p.lastSyncAt).toLocaleDateString() : '—' },
    { label: 'Success Rate', value: p.activationSuccessRate != null ? `${Math.round(p.activationSuccessRate)}%` : '—' },
    { label: 'Failures', value: p.errorCount || 0 },
    { label: 'Avg Response', value: snap?.responseTimeMs ? `${snap.responseTimeMs}ms` : '—' },
    { label: 'Last Error', value: p.lastError || '—' },
  ]

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Provider Health</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {cards.map(c => (
          <div key={c.label} className="rounded-lg bg-gray-50 p-3">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">{c.label}</p>
            <p className={`mt-1 text-sm font-semibold truncate ${c.value === '—' ? 'text-gray-300' : c.label === 'Last Error' ? 'text-red-600' : 'text-gray-900'}`}
              title={typeof c.value === 'string' && c.value.length > 20 ? c.value : undefined}>
              {c.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProviderCapabilityMatrix({ provider }: { provider: any }) {
  const p = provider || {}
  const ep = (p.endpointMappings || {}) as Record<string, string>
  const certStatus = p.certificationStatus || 'CONFIGURING'

  const tested = (cap: string) => {
    // Derive tested status from certification progression
    const levels: Record<string, number> = {
      Authentication: 2, PlanSync: 4, Import: 5, Purchase: 6, Usage: 7, Topup: 8,
    }
    const stepNames = ['CONFIGURING', 'AUTHENTICATED', 'CONNECTED', 'PLANS_SYNCED', 'PLANS_IMPORTED', 'PURCHASE_TESTED', 'USAGE_TESTED', 'TOPUP_TESTED', 'CERTIFIED']
    const stepIdx = stepNames.indexOf(certStatus)
    const capIdx = levels[cap] || 0
    return stepIdx >= capIdx ? 'Tested' : stepIdx >= capIdx - 1 ? 'Configured' : 'Pending'
  }

  const capabilities = [
    { name: 'Authentication', supported: !!ep.AUTH_LOGIN || !!p.authUrl },
    { name: 'Plan Sync', supported: !!ep.GET_PLANS || !!p.planListPath },
    { name: 'Import', supported: true },
    { name: 'Purchase', supported: !!ep.PURCHASE_ESIM || !!ep.PURCHASE_INITIATE || !!p.activationPath },
    { name: 'Usage', supported: !!ep.GET_USAGE || !!p.usagePath },
    { name: 'Top-up', supported: !!ep.TOP_UP || !!ep.RENEW_ESIM || !!p.topUpPath },
    { name: 'Cancel', supported: !!ep.SUSPEND_ESIM || !!p.suspendPath },
    { name: 'Webhook', supported: p.supportsWebhookPush || !!ep.WEBHOOK },
    { name: 'Inventory', supported: !!ep.GET_INVENTORY || !!ep.GET_INVENTORIES },
    { name: 'Coverage', supported: !!ep.GET_COUNTRIES || !!ep.COUNTRY_REGION_DETAILS },
  ]

  const statusColor = (tested: string) => {
    if (tested === 'Tested') return 'bg-emerald-100 text-emerald-700'
    if (tested === 'Configured') return 'bg-blue-100 text-blue-700'
    return 'bg-gray-100 text-gray-400'
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Capability Matrix</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
        {capabilities.map(cap => {
          const status = tested(cap.name)
          return (
            <div key={cap.name} className={`rounded-lg p-3 border ${cap.supported ? 'border-gray-100' : 'border-dashed border-gray-200'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-700">{cap.name}</span>
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${cap.supported ? 'bg-green-50 text-green-600' : 'bg-gray-50 text-gray-400'}`}>
                  {cap.supported ? '✓' : '—'}
                </span>
              </div>
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium ${statusColor(status)}`}>
                {status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
