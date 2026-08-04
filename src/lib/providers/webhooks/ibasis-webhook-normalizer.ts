import type { NormalizedWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'

/**
 * iBASIS notification normalizer.
 *
 * Handles 4 notification types from the iBASIS Consumer Offer API:
 *  1. Activation status change
 *  2. Subscription activated
 *  3. Data usage
 *  4. Threshold
 *
 * All use `notification_id` as the stable external event ID.
 * VOICE and SMS usage notifications are persisted as IGNORED.
 */
export function normalizeIbasisWebhook(payload: any): NormalizedWebhookEvent {
  const notificationType = identifyNotificationType(payload)

  switch (notificationType) {
    case 'activation_status':
      return normalizeActivationStatus(payload)
    case 'subscription_activated':
      return normalizeSubscriptionActivated(payload)
    case 'data_usage':
      return normalizeDataUsage(payload)
    case 'threshold':
      return normalizeThreshold(payload)
    default:
      return {
        providerType: 'IBASIS',
        eventType: 'UNKNOWN',
        externalEventId: payload?.notification_id || undefined,
        raw: payload || {},
      }
  }
}

function identifyNotificationType(payload: any): string {
  if (!payload || typeof payload !== 'object') return 'unknown'
  if (payload.subscription_activation_id && payload.status && !payload.subscription_id && !payload.type) return 'activation_status'
  if (payload.subscription_activation_id && payload.subscription_id && !payload.type) return 'subscription_activated'
  if (payload.type === 'DATA') return 'data_usage'
  if (payload.type && payload.type !== 'DATA') return 'voice_sms'
  if (payload.balance) return 'threshold'
  return 'unknown'
}

function normalizeActivationStatus(payload: any): NormalizedWebhookEvent {
  const status = String(payload.status || '').toLowerCase()

  return {
    providerType: 'IBASIS',
    eventType: ['completed'].includes(status) ? 'ESIM_ACTIVATED' : ['rejected', 'failed'].includes(status) ? 'PROVIDER_ERROR' : 'USAGE_UPDATED',
    externalEventId: payload.notification_id,
    providerStatus: payload.status,
    raw: payload,
  }
}

function normalizeSubscriptionActivated(payload: any): NormalizedWebhookEvent {
  return {
    providerType: 'IBASIS',
    eventType: 'ESIM_ACTIVATED',
    externalEventId: payload.notification_id,
    providerStatus: 'completed',
    raw: payload,
  }
}

function normalizeDataUsage(payload: any): NormalizedWebhookEvent {
  const rawUsage = Number(payload.usage)
  if (!isFinite(rawUsage) || rawUsage < 0) {
    return {
      providerType: 'IBASIS',
      eventType: 'UNKNOWN',
      externalEventId: payload.notification_id,
      raw: payload,
    }
  }
  const dataUsedMB = rawUsage / (1024 * 1024) // bytes → MB

  return {
    providerType: 'IBASIS',
    eventType: 'USAGE_UPDATED',
    externalEventId: payload.notification_id,
    dataUsedMB: Math.round(dataUsedMB * 100) / 100,
    usageDate: payload.timestamp,
    raw: payload,
  }
}

function normalizeThreshold(payload: any): NormalizedWebhookEvent {
  const balance = payload.balance || {}
  const dataBytes = Number(balance.data)
  if (!isFinite(dataBytes) || dataBytes < 0) {
    return {
      providerType: 'IBASIS',
      eventType: 'UNKNOWN',
      externalEventId: payload.notification_id,
      raw: payload,
    }
  }
  const dataRemainingMB = dataBytes / (1024 * 1024)

  return {
    providerType: 'IBASIS',
    eventType: 'USAGE_UPDATED',
    externalEventId: payload.notification_id,
    dataRemainingMB: Math.round(dataRemainingMB * 100) / 100,
    usageDate: payload.timestamp,
    raw: payload,
  }
}
