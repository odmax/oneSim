import { prisma } from '@/lib/prisma'

export interface HealthEvent {
  eventType: 'AUTH_FAILURE' | 'CONNECTION_TEST' | 'SYNC' | 'ACTIVATION_FAILURE' | 'TOKEN_EXPIRED' | 'TOKEN_REFRESHED' | 'REQUEST_SUCCESS'
  success: boolean
  message?: string
  durationMs?: number
  timestamp: string
}

export async function recordHealthEvent(
  providerId: string,
  event: Omit<HealthEvent, 'timestamp'>
): Promise<void> {
  const eventWithTimestamp: HealthEvent = { ...event, timestamp: new Date().toISOString() }

  await prisma.provider.update({
    where: { id: providerId },
    data: {
      config: {
        ...await getConfig(providerId),
        healthLog: await appendHealthLog(providerId, eventWithTimestamp),
        lastHealthEvent: eventWithTimestamp,
      },
    },
  })
}

export async function recordActivationResult(
  providerId: string,
  success: boolean,
  durationMs: number
): Promise<void> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { activationSuccessRate: true, averageActivationTimeMs: true, errorCount: true },
  })

  const currentRate = provider?.activationSuccessRate ?? null
  const currentAvgMs = provider?.averageActivationTimeMs ?? null
  const currentErrors = provider?.errorCount ?? 0

  const healthUpdate: any = {}

  if (success) {
    if (currentRate !== null) {
      healthUpdate.activationSuccessRate = Math.round((currentRate * 0.9 + 100 * 0.1) * 10) / 10
    } else {
      healthUpdate.activationSuccessRate = 100
    }
    if (currentAvgMs !== null) {
      healthUpdate.averageActivationTimeMs = Math.round(currentAvgMs * 0.9 + durationMs * 0.1)
    } else {
      healthUpdate.averageActivationTimeMs = durationMs
    }
    healthUpdate.lastSuccessfulConnection = new Date()
  } else {
    healthUpdate.errorCount = currentErrors + 1
    healthUpdate.lastFailedConnection = new Date()
    if (currentRate !== null) {
      healthUpdate.activationSuccessRate = Math.round(Math.max(0, currentRate * 0.9) * 10) / 10
    } else {
      healthUpdate.activationSuccessRate = 0
    }
  }

  await prisma.provider.update({ where: { id: providerId }, data: healthUpdate })
}

export async function getRecentHealthLogs(
  providerId: string,
  limit: number = 20
): Promise<HealthEvent[]> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { config: true },
  })
  const config = provider?.config as any || {}
  const logs: HealthEvent[] = config.healthLog || []
  return logs.slice(-limit)
}

async function getConfig(providerId: string): Promise<any> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { config: true },
  })
  return (provider?.config as any) || {}
}

async function appendHealthLog(
  providerId: string,
  event: HealthEvent
): Promise<HealthEvent[]> {
  const config = await getConfig(providerId)
  const logs: HealthEvent[] = config.healthLog || []
  logs.push(event)
  const maxLogs = 100
  return logs.length > maxLogs ? logs.slice(-maxLogs) : logs
}
