'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { TelnaConnector } from '@/lib/providers/connectors/telna-connector'
import { mapTelnaUsage, mapTelnaSession, mapTelnaBalance } from '@/lib/providers/mappers/telna-usage-mapper'

function isTelnaConnector(c: unknown): c is TelnaConnector {
  return c !== null && typeof c === 'object' && 'getSimUsage' in c
}

export async function telnaSyncUsage(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: { select: { providerId: true } } } } },
  })
  if (!esim || !esim.iccid) return { error: 'eSIM not found or no ICCID' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { error: 'No linked provider' }

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector || !isTelnaConnector(connector)) return { error: 'Provider not available' }

  const startTime = Date.now()
  const result = await connector.getSimUsage(esim.iccid)
  if (!result.success || !result.data) {
    return { error: result.error?.message || 'Usage fetch failed' }
  }

  const mapped = mapTelnaUsage(result.data.usage)

  await prisma.usageRecord.create({
    data: {
      esimId,
      dataUsedMB: mapped.dataUsedMB ?? 0,
      dataTotalMB: mapped.dataTotalMB ?? undefined,
      dataRemainingMB: mapped.dataRemainingMB ?? undefined,
      dataPercentage: mapped.percentageUsed ?? undefined,
      timestamp: mapped.timestamp ? new Date(mapped.timestamp) : new Date(),
      rawData: mapped.rawData as any,
    },
  })

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      dataUsedMB: mapped.dataUsedMB ?? 0,
      dataTotalMB: mapped.dataTotalMB ?? undefined,
      dataRemainingMB: mapped.dataRemainingMB ?? undefined,
      lastUsageSyncAt: new Date(),
      lastSyncAt: new Date(),
    },
  })

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: 'SIM_USAGE_UPDATED' as any,
    providerId,
    providerCode: null,
    packageId: null,
    comparableKey: null,
    changedFields: ['usage'],
    trigger: 'USER_ACTION',
    userId: session.user.id,
    metadata: {
      iccid: esim.iccid, esimId,
      dataUsedMB: mapped.dataUsedMB,
      dataTotalMB: mapped.dataTotalMB,
      percentageUsed: mapped.percentageUsed,
      durationMs: Date.now() - startTime,
    },
  })

  console.log(`[TELNA_USAGE] iccid=${esim.iccid} esimId=${esimId} status=success dataUsedMB=${mapped.dataUsedMB} durationMs=${Date.now() - startTime}`)

  return { success: true, data: mapped }
}

export async function telnaSyncSessions(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: { select: { providerId: true } } } } },
  })
  if (!esim || !esim.iccid) return { error: 'eSIM not found or no ICCID' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { error: 'No linked provider' }

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector || !isTelnaConnector(connector)) return { error: 'Provider not available' }

  const startTime = Date.now()

  const allSessions: any[] = []
  let offset = 0
  const PAGE_SIZE = 100
  let hasMore = true

  while (hasMore) {
    const result = await connector.listSimSessions(esim.iccid, PAGE_SIZE, offset)
    if (!result.success) return { error: result.error?.message || 'Failed to list sessions' }
    const items = result.data?.items || []
    allSessions.push(...items)
    offset += PAGE_SIZE
    if (offset >= (result.data?.total || 0) || items.length === 0) hasMore = false
  }

  let created = 0
  for (const raw of allSessions) {
    const mapped = mapTelnaSession(raw)
    if (!mapped.startTime) continue
    await prisma.usageSession.create({
      data: {
        esimId,
        sessionId: mapped.sessionId || undefined,
        startTime: new Date(mapped.startTime),
        endTime: mapped.endTime ? new Date(mapped.endTime) : undefined,
        durationSec: mapped.durationSec ?? undefined,
        dataUsedMB: mapped.dataUsedMB ?? undefined,
        country: mapped.country || undefined,
        operator: mapped.operator || undefined,
        network: mapped.network || undefined,
        rawData: mapped.rawData as any,
      },
    })
    created++
  }

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: 'SIM_SESSION_RECORDED' as any,
    providerId,
    providerCode: null,
    packageId: null,
    comparableKey: null,
    changedFields: ['sessions'],
    trigger: 'USER_ACTION',
    userId: session.user.id,
    metadata: { iccid: esim.iccid, esimId, sessionCount: created, durationMs: Date.now() - startTime },
  })

  console.log(`[TELNA_SESSION] iccid=${esim.iccid} esimId=${esimId} status=success sessions=${created} durationMs=${Date.now() - startTime}`)

  return { success: true, sessionCount: created }
}

export async function telnaSyncBalances(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: { select: { providerId: true } } } } },
  })
  if (!esim || !esim.iccid) return { error: 'eSIM not found or no ICCID' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { error: 'No linked provider' }

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector || !isTelnaConnector(connector)) return { error: 'Provider not available' }

  const startTime = Date.now()
  const result = await connector.getSimBalances(esim.iccid)
  if (!result.success || !result.data) {
    return { error: result.error?.message || 'Balance fetch failed' }
  }

  const mapped = mapTelnaBalance(result.data.balance)

  await prisma.usageRecord.create({
    data: {
      esimId,
      dataUsedMB: 0,
      dataRemainingMB: mapped.dataRemainingMB ?? undefined,
      dataTotalMB: mapped.dataRemainingMB ?? undefined,
      timestamp: mapped.timestamp ? new Date(mapped.timestamp) : new Date(),
      rawData: mapped.rawData as any,
    },
  })

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: 'SIM_BALANCE_UPDATED' as any,
    providerId,
    providerCode: null,
    packageId: null,
    comparableKey: null,
    changedFields: ['balance'],
    trigger: 'USER_ACTION',
    userId: session.user.id,
    metadata: { iccid: esim.iccid, esimId, balance: mapped.balance, dataRemainingMB: mapped.dataRemainingMB, durationMs: Date.now() - startTime },
  })

  console.log(`[TELNA_BALANCE] iccid=${esim.iccid} esimId=${esimId} status=success balance=${mapped.balance} durationMs=${Date.now() - startTime}`)

  return { success: true, data: mapped }
}

export async function telnaGetAnalytics(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: { select: { providerId: true } } } } },
  })
  if (!esim) return { error: 'eSIM not found' }

  const usageRecords = await prisma.usageRecord.findMany({
    where: { esimId },
    orderBy: { timestamp: 'desc' },
    take: 90,
  })

  if (usageRecords.length === 0) return { success: true, data: { totalRecords: 0, message: 'No usage data' } }

  const latest = usageRecords[0]
  const oldest = usageRecords[usageRecords.length - 1]

  const dailyUsage: Record<string, number> = {}
  const weeklyUsage: Record<string, number> = {}
  const monthlyUsage: Record<string, number> = {}

  for (const r of usageRecords) {
    const dayKey = r.timestamp.toISOString().slice(0, 10)
    const weekKey = getWeekKey(r.timestamp)
    const monthKey = r.timestamp.toISOString().slice(0, 7)

    dailyUsage[dayKey] = (dailyUsage[dayKey] || 0) + r.dataUsedMB
    weeklyUsage[weekKey] = (weeklyUsage[weekKey] || 0) + r.dataUsedMB
    monthlyUsage[monthKey] = (monthlyUsage[monthKey] || 0) + r.dataUsedMB
  }

  const daysSpan = Math.max(1, Math.round((latest.timestamp.getTime() - oldest.timestamp.getTime()) / (1000 * 60 * 60 * 24)))
  const totalUsed = usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
  const avgDailyMB = Math.round(totalUsed / daysSpan)

  const remainingMB = latest.dataRemainingMB ?? esim.dataRemainingMB ?? null
  let remainingDays: number | null = null
  if (remainingMB !== null && avgDailyMB > 0) {
    remainingDays = Math.round(remainingMB / avgDailyMB)
  }

  return {
    success: true,
    data: {
      totalRecords: usageRecords.length,
      totalUsedMB: totalUsed,
      avgDailyMB,
      remainingMB,
      remainingDays,
      latestRecord: {
        dataUsedMB: latest.dataUsedMB,
        dataRemainingMB: latest.dataRemainingMB,
        dataTotalMB: latest.dataTotalMB,
        percentageUsed: latest.dataPercentage,
        timestamp: latest.timestamp,
      },
      daily: Object.entries(dailyUsage).map(([date, mb]) => ({ date, mb })),
      weekly: Object.entries(weeklyUsage).map(([week, mb]) => ({ week, mb })),
      monthly: Object.entries(monthlyUsage).map(([month, mb]) => ({ month, mb })),
    },
  }
}

function getWeekKey(d: Date): string {
  const start = new Date(d)
  start.setDate(start.getDate() - start.getDay())
  return start.toISOString().slice(0, 10)
}

export async function telnaGetDashboard() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esims = await prisma.eSIM.findMany({
    where: { iccid: { not: '' } },
    include: { usageRecords: { orderBy: { timestamp: 'desc' }, take: 1 } },
  })

  const topConsumers: { esimId: string; iccid: string; totalMB: number }[] = []
  let dormantCount = 0
  let zeroUsageCount = 0
  let nearExhaustionCount = 0
  let totalUsageMB = 0

  for (const esim of esims) {
    const records = await prisma.usageRecord.findMany({
      where: { esimId: esim.id },
      orderBy: { timestamp: 'desc' },
      take: 30,
    })

    if (records.length === 0) {
      zeroUsageCount++
      continue
    }

    const totalMB = records.reduce((s, r) => s + r.dataUsedMB, 0)
    totalUsageMB += totalMB
    topConsumers.push({ esimId: esim.id, iccid: esim.iccid || '', totalMB })

    const latestRecord = records[0]
    const daysSinceLastUsage = Math.round((Date.now() - latestRecord.timestamp.getTime()) / (1000 * 60 * 60 * 24))
    if (daysSinceLastUsage > 30) dormantCount++

    if (latestRecord.dataRemainingMB !== null && latestRecord.dataRemainingMB < 100) {
      nearExhaustionCount++
    }
  }

  topConsumers.sort((a, b) => b.totalMB - a.totalMB)

  return {
    success: true,
    data: {
      totalEsims: esims.length,
      totalUsageMB,
      totalSessions: await prisma.usageSession.count(),
      totalAlerts: await prisma.usageAlert.count(),
      topConsumers: topConsumers.slice(0, 10),
      dormantCount,
      zeroUsageCount,
      nearExhaustionCount,
    },
  }
}

export async function telnaGenerateAlerts() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const alerts: { esimId: string; alertType: string; severity: string; message: string }[] = []
  const startTime = Date.now()

  const esims = await prisma.eSIM.findMany({
    where: { iccid: { not: '' } },
    include: { purchase: { include: { package: { select: { providerId: true, providerName: true } } } } },
  })

  for (const esim of esims) {
    const records = await prisma.usageRecord.findMany({
      where: { esimId: esim.id },
      orderBy: { timestamp: 'desc' },
      take: 30,
    })

    if (records.length === 0) {
      alerts.push({
        esimId: esim.id,
        alertType: 'NO_ACTIVITY',
        severity: 'WARNING',
        message: `SIM ${esim.iccid} has no usage records`,
      })
      continue
    }

    const latest = records[0]
    const daysSinceLastUsage = Math.round((Date.now() - latest.timestamp.getTime()) / (1000 * 60 * 60 * 24))
    if (daysSinceLastUsage > 30) {
      alerts.push({
        esimId: esim.id,
        alertType: 'NO_ACTIVITY',
        severity: 'WARNING',
        message: `SIM ${esim.iccid} has had no activity for ${daysSinceLastUsage} days`,
      })
    }

    if (latest.dataRemainingMB !== null && latest.dataTotalMB !== null && latest.dataTotalMB > 0) {
      const usedMB = latest.dataTotalMB - latest.dataRemainingMB
      const pct = Math.round((usedMB / latest.dataTotalMB) * 100)
      if (pct >= 100) {
        alerts.push({ esimId: esim.id, alertType: 'USAGE_100', severity: 'CRITICAL', message: `SIM ${esim.iccid} has exhausted its data allowance` })
      } else if (pct >= 90) {
        alerts.push({ esimId: esim.id, alertType: 'USAGE_90', severity: 'WARNING', message: `SIM ${esim.iccid} has used ${pct}% of data allowance` })
      } else if (pct >= 80) {
        alerts.push({ esimId: esim.id, alertType: 'USAGE_80', severity: 'INFO', message: `SIM ${esim.iccid} has used ${pct}% of data allowance` })
      }
    }

    if (records.length >= 3) {
      const recent = records.slice(0, 3).reduce((s, r) => s + r.dataUsedMB, 0)
      const earlier = records.slice(3, 6).reduce((s, r) => s + r.dataUsedMB, 0)
      const avgRecent = recent / 3
      const avgEarlier = earlier / 3
      if (avgEarlier > 0 && avgRecent > avgEarlier * 3) {
        alerts.push({
          esimId: esim.id,
          alertType: 'USAGE_SPIKE',
          severity: 'WARNING',
          message: `SIM ${esim.iccid} usage spike: recent avg ${Math.round(avgRecent)}MB vs ${Math.round(avgEarlier)}MB (${Math.round((avgRecent / avgEarlier) * 100)}%)`,
        })
      }
    }
  }

  // Persist alerts
  let created = 0
  for (const alert of alerts) {
    try {
      await prisma.usageAlert.create({ data: alert })
      created++
    } catch { }
  }

  const { emitEvent } = await import('@/lib/catalog-events')
  for (const alert of alerts) {
    emitEvent({
      eventType: 'SIM_ALERT_CREATED' as any,
      providerId: null,
      providerCode: null,
      packageId: null,
      comparableKey: null,
      changedFields: [],
      trigger: 'SYSTEM',
      userId: session.user.id,
      metadata: { esimId: alert.esimId, alertType: alert.alertType, severity: alert.severity, message: alert.message },
    })
  }

  console.log(`[TELNA_ALERT] status=success alerts=${created} durationMs=${Date.now() - startTime}`)

  return { success: true, alertCount: created }
}

export async function telnaExportUsage(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const esim = await prisma.eSIM.findUnique({ where: { id: esimId } })
  if (!esim) return { error: 'eSIM not found' }

  const records = await prisma.usageRecord.findMany({
    where: { esimId },
    orderBy: { timestamp: 'desc' },
  })

  const sessions = await prisma.usageSession.findMany({
    where: { esimId },
    orderBy: { startTime: 'desc' },
  })

  const header = 'Timestamp,DataUsedMB,DataTotalMB,DataRemainingMB,Percentage\n'
  const rows = records.map(r => `${r.timestamp.toISOString()},${r.dataUsedMB},${r.dataTotalMB ?? ''},${r.dataRemainingMB ?? ''},${r.dataPercentage ?? ''}`).join('\n')

  const sessionHeader = '\n\nSessionStart,SessionEnd,DurationSec,DataUsedMB,Country,Operator\n'
  const sessionRows = sessions.map(s => `${s.startTime.toISOString()},${s.endTime?.toISOString() ?? ''},${s.durationSec ?? ''},${s.dataUsedMB ?? ''},${s.country ?? ''},${s.operator ?? ''}`).join('\n')

  return {
    success: true,
    data: {
      csv: header + rows + sessionHeader + sessionRows,
      filename: `usage-${esim.iccid}-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  }
}
