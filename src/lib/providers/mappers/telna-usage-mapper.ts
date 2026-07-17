import type { TelnaUsage, MappedTelnaUsage, TelnaSession, MappedTelnaSession, TelnaBalance, MappedTelnaBalance, TelnaConsumption, MappedTelnaConsumption } from '../connectors/telna-endpoints'

export function mapTelnaUsage(usage: TelnaUsage): MappedTelnaUsage {
  const bytesUsed = usage.bytes_used ?? null
  const bytesRemaining = usage.bytes_remaining ?? null
  const totalAllowance = usage.total_allowance ?? null
  const dataUsedMB = usage.data_used_mb ?? (bytesUsed != null ? Math.round(bytesUsed / (1024 * 1024)) : null)
  const dataRemainingMB = usage.data_remaining_mb ?? (bytesRemaining != null ? Math.round(bytesRemaining / (1024 * 1024)) : null)
  const dataTotalMB = usage.data_total_mb ?? (totalAllowance != null ? Math.round(totalAllowance / (1024 * 1024)) : null)

  return {
    iccid: usage.iccid,
    packageName: usage.package_name || null,
    bytesUsed,
    bytesRemaining,
    totalAllowance,
    percentageUsed: usage.percentage_used ?? null,
    dataUsedMB,
    dataRemainingMB,
    dataTotalMB,
    timestamp: usage.timestamp || null,
    rawData: usage as Record<string, unknown>,
  }
}

export function mapTelnaSession(session: TelnaSession): MappedTelnaSession {
  const durationSec = session.duration_sec ?? null
  let durationLabel: string | null = null
  if (durationSec !== null) {
    if (durationSec < 60) durationLabel = `${durationSec}s`
    else if (durationSec < 3600) durationLabel = `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    else durationLabel = `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`
  }

  return {
    sessionId: session.session_id != null ? String(session.session_id) : null,
    startTime: session.start_time || null,
    endTime: session.end_time || null,
    durationSec,
    durationLabel,
    dataUsedMB: session.data_used_mb ?? null,
    country: session.country || null,
    operator: session.operator || null,
    network: session.network || null,
    cost: session.cost ?? null,
    currency: session.currency || null,
    rawData: session as Record<string, unknown>,
  }
}

export function mapTelnaBalance(balance: TelnaBalance): MappedTelnaBalance {
  const dataRemainingMB = balance.data_remaining_mb ?? (balance.data_remaining_bytes != null ? Math.round(balance.data_remaining_bytes / (1024 * 1024)) : null)

  return {
    iccid: balance.iccid || null,
    balance: balance.balance ?? null,
    currency: balance.currency || null,
    dataRemainingMB,
    monetaryBalance: balance.monetary_balance ?? null,
    timestamp: balance.timestamp || null,
    rawData: balance as Record<string, unknown>,
  }
}

export function mapTelnaConsumption(consumption: TelnaConsumption): MappedTelnaConsumption {
  return {
    iccid: consumption.iccid || null,
    period: consumption.period || null,
    totalBytes: consumption.total_bytes ?? null,
    totalMB: consumption.total_mb ?? null,
    sessionsCount: consumption.sessions_count ?? null,
    uniqueCountries: consumption.unique_countries ?? null,
    cost: consumption.cost ?? null,
    currency: consumption.currency || null,
    fromDate: consumption.from_date || null,
    toDate: consumption.to_date || null,
    rawData: consumption as Record<string, unknown>,
  }
}
