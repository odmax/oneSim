import type { NormalizedWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'

const finite = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

const toIsoTimestamp = (value: unknown): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = finite(value)
  const date = numeric !== undefined && (typeof value === 'number' || /^\d+$/.test(String(value)))
    ? new Date(numeric)
    : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

const bytesToMb = (bytes: number | undefined): number | undefined => {
  if (bytes === undefined) return undefined
  // The persistence model stores whole MB. Preserve any real positive usage
  // as at least 1 MB so small but authoritative byte counts still activate.
  return bytes > 0 ? Math.max(1, Math.round(bytes / (1024 * 1024))) : 0
}

/** Normalize Telna Webhooks.pdf events without treating local profile actions
 * as network attachment or package activation as proof of real usage. */
export function normalizeTelnaWebhook(payload: any): NormalizedWebhookEvent {
  const name = String(payload?.eventName || payload?.event || payload?.type || '').toUpperCase()
  const details = payload?.eventDetails || {}
  const iccid = details?.sim?.iccid || payload?.iccid
  const packageInfo = details?.package || {}
  const currentValue = String(packageInfo?.status?.currentValue || '').toUpperCase()
  const timestamp = payload?.eventTimestamp ?? payload?.timestamp

  if (name === 'ESIM_STATUS_CHANGE' || name === 'HANDLEDOWNLOADPROGRESSINFO' || payload?.notificationPointId != null) {
    const point = String(payload?.notificationPointId ?? '')
    const result = String(payload?.notificationPointStatus?.status || '').toLowerCase()
    const callbackId = payload?.header?.functionCallIdentifier
    const common = {
      providerType: 'TELNA',
      externalEventId: callbackId
        ? `TELNA:RSP:${callbackId}`
        : `TELNA:RSP:${iccid || ''}:${point}:${timestamp || ''}`,
      iccid: iccid ? String(iccid) : undefined,
      providerStatus: `RSP_CHECKPOINT_${point}`,
      raw: payload,
    }

    if (result === 'failed' || result === 'expired') {
      return { ...common, eventType: 'ESIM_INSTALLATION_FAILED', installationStatus: 'FAILED' }
    }
    if (result !== 'executed-success' && result !== 'executed-withwarning') {
      return { ...common, eventType: 'UNKNOWN' }
    }
    switch (point) {
      case '3':
        return { ...common, eventType: 'ESIM_PROFILE_DOWNLOADED', installationStatus: 'DOWNLOADED' }
      case '4':
        return { ...common, eventType: 'ESIM_INSTALLED', installationStatus: 'INSTALLED' }
      case '6':
        return { ...common, eventType: 'ESIM_INSTALLED', installationStatus: 'ENABLED' }
      case '7':
        return { ...common, eventType: 'ESIM_PROFILE_DISABLED', installationStatus: 'DISABLED' }
      case '8':
        return { ...common, eventType: 'ESIM_PROFILE_DELETED', installationStatus: 'DELETED' }
      case '1':
      case '2':
        return { ...common, eventType: 'ESIM_INSTALLATION_FAILED', installationStatus: 'FAILED' }
      default:
        return { ...common, eventType: 'UNKNOWN' }
    }
  }

  if (name === 'PACKAGE_DATA_USAGE_ALERT') {
    const usedBytes = finite(packageInfo?.packageUsedBytes)
    const totalBytes = finite(packageInfo?.packageTotalBytes)
    const usedMB = bytesToMb(usedBytes)
    const totalMB = bytesToMb(totalBytes)
    const usageDate = toIsoTimestamp(timestamp)
    const externalEventId = `TELNA:USAGE:${packageInfo?.id || ''}:${iccid || ''}:${timestamp || ''}`
    return {
      providerType: 'TELNA',
      eventType: 'USAGE_UPDATED',
      externalEventId,
      iccid: iccid ? String(iccid) : undefined,
      providerStatus: undefined,
      usageDate,
      dataUsedMB: usedMB,
      dataTotalMB: totalMB,
      dataRemainingMB: usedMB !== undefined && totalMB !== undefined ? Math.max(0, totalMB - usedMB) : undefined,
      raw: payload,
    }
  }

  if (name === 'PACKAGE_STATUS_CHANGE') {
    const eventType = currentValue === 'ACTIVATED'
      ? 'ESIM_ACTIVATED'
      : currentValue === 'TERMINATED' ? 'ESIM_EXPIRED' : 'UNKNOWN'
    return {
      providerType: 'TELNA',
      eventType,
      externalEventId: `TELNA:PACKAGE:${packageInfo?.id || ''}:${iccid || ''}:${currentValue}:${timestamp || ''}`,
      iccid: iccid ? String(iccid) : undefined,
      providerStatus: currentValue || undefined,
      raw: payload,
    }
  }

  return {
    providerType: 'TELNA',
    eventType: 'UNKNOWN',
    externalEventId: `TELNA:UNKNOWN:${name}:${iccid || ''}:${timestamp || ''}`,
    iccid: iccid ? String(iccid) : undefined,
    providerStatus: undefined,
    raw: payload,
  }
}
