'use client'

import { deriveUsageMetrics } from '@/lib/esim/usage-metrics'

export function UsageBar({ dataUsedMB, dataTotalMB, dataRemainingMB, label }: {
  dataUsedMB?: number | null
  dataTotalMB?: number | null
  dataRemainingMB?: number | null
  label?: string
}) {
  const metrics = deriveUsageMetrics(dataUsedMB, dataTotalMB, dataRemainingMB)

  if (!metrics.hasSnapshot) {
    return (
      <div className="space-y-1">
        {label && <p className="text-xs font-medium text-gray-500">{label}</p>}
        <p className="text-sm text-gray-400">Usage unavailable</p>
      </div>
    )
  }

  const { used, total, remaining, percentage } = metrics
  const usageGB = (used / 1024).toFixed(2)
  const totalGB = (total / 1024).toFixed(2)
  const remainingGB = (remaining / 1024).toFixed(2)

  const barColor = percentage >= 90 ? 'bg-red-500' : percentage >= 70 ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium text-gray-500">{label}</p>}
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-900">{usageGB} GB</span>
        {total > 0 && <span className="text-xs text-gray-400">of {totalGB} GB</span>}
      </div>
      {total > 0 && (
        <div className="h-2 w-full rounded-full bg-gray-100">
          <div className={`h-2 rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(percentage, 100)}%` }} />
        </div>
      )}
      <div className="flex justify-between text-xs text-gray-400">
        <span>{percentage}% used</span>
        <span>{remainingGB} GB remaining</span>
      </div>
    </div>
  )
}

export function UsageSummary({ dataUsedMB, dataTotalMB, dataRemainingMB, lastUsageAt, lastUsageSyncAt, expiresAt, status }: {
  dataUsedMB?: number | null
  dataTotalMB?: number | null
  dataRemainingMB?: number | null
  lastUsageAt?: Date | null
  lastUsageSyncAt?: Date | null
  expiresAt?: Date | null
  status?: string | null
}) {
  const metrics = deriveUsageMetrics(dataUsedMB, dataTotalMB, dataRemainingMB)
  const used = metrics.used
  const total = metrics.total
  const remaining = metrics.remaining

  const isExpired = status === 'EXPIRED'
  const expiredSoon = expiresAt && !isExpired && new Date(expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000

  return (
    <div className="space-y-3">
      <UsageBar dataUsedMB={dataUsedMB} dataTotalMB={dataTotalMB} dataRemainingMB={dataRemainingMB} />
      <dl className="space-y-1.5 text-xs">
        {metrics.hasSnapshot && (
          <>
            <div className="flex justify-between">
              <dt className="text-gray-500">Data Used</dt>
              <dd className="font-medium text-gray-900">{(used / 1024).toFixed(2)} GB</dd>
            </div>
            {total > 0 && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Total Data</dt>
                <dd className="font-medium text-gray-900">{(total / 1024).toFixed(2)} GB</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Remaining</dt>
              <dd className={`font-medium ${remaining <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                {Math.max(0, remaining / 1024).toFixed(2)} GB
              </dd>
            </div>
          </>
        )}
        {expiresAt && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Expires</dt>
            <dd className={`font-medium ${expiredSoon ? 'text-amber-600' : isExpired ? 'text-red-600' : 'text-gray-900'}`}>
              {new Date(expiresAt).toLocaleDateString()}
              {expiredSoon && ' (soon)'}
              {isExpired && ' (expired)'}
            </dd>
          </div>
        )}
        {lastUsageAt && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Last Usage</dt>
            <dd className="text-gray-500">{new Date(lastUsageAt).toLocaleDateString()}</dd>
          </div>
        )}
        {lastUsageSyncAt && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Last Refreshed</dt>
            <dd className="text-gray-400">{new Date(lastUsageSyncAt).toLocaleDateString()}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
