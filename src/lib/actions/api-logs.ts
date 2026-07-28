'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
}

export async function getApiLogs(params: {
  page?: number
  pageSize?: number
  businessId?: string
  method?: string
  statusCode?: number
  path?: string
  dateFrom?: string
  dateTo?: string
}) {
  await requireAdmin()
  const page = params.page || 1
  const pageSize = params.pageSize || 50
  const skip = (page - 1) * pageSize

  const where: any = {}
  if (params.businessId) where.businessId = params.businessId
  if (params.method) where.method = params.method
  if (params.statusCode) where.statusCode = params.statusCode
  if (params.path) where.path = { contains: params.path }
  if (params.dateFrom || params.dateTo) {
    where.createdAt = {}
    if (params.dateFrom) where.createdAt.gte = new Date(params.dateFrom)
    if (params.dateTo) where.createdAt.lte = new Date(params.dateTo)
  }

  const [logs, total] = await Promise.all([
    prisma.apiRequestLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        business: { select: { id: true, name: true } },
      },
    }),
    prisma.apiRequestLog.count({ where }),
  ])

  return { logs, total, page, pageSize }
}

export async function getApiLogSummary() {
  await requireAdmin()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [requestsToday, failedRequests, topBusinesses, rateLimitHits] = await Promise.all([
    prisma.apiRequestLog.count({
      where: { createdAt: { gte: today } },
    }),
    prisma.apiRequestLog.count({
      where: { createdAt: { gte: today }, statusCode: { gte: 400 } },
    }),
    prisma.apiRequestLog.groupBy({
      by: ['businessId'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    prisma.apiRequestLog.count({
      where: { createdAt: { gte: today }, statusCode: 429 },
    }),
  ])

  const businessIds = topBusinesses.map(b => b.businessId)
  const businesses = businessIds.length > 0
    ? await prisma.business.findMany({
        where: { id: { in: businessIds } },
        select: { id: true, name: true },
      })
    : []

  const topBusinessList = topBusinesses.map(b => ({
    businessId: b.businessId,
    name: businesses.find(biz => biz.id === b.businessId)?.name || 'Unknown',
    count: b._count.id,
  }))

  return { requestsToday, failedRequests, topBusinessList, rateLimitHits }
}

export async function getBusinessApiUsage(businessId: string) {
  await requireAdmin()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [logs, requestsToday, failedToday, rateLimitHits] = await Promise.all([
    prisma.apiRequestLog.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.apiRequestLog.count({
      where: { businessId, createdAt: { gte: today } },
    }),
    prisma.apiRequestLog.count({
      where: { businessId, createdAt: { gte: today }, statusCode: { gte: 400 } },
    }),
    prisma.apiRequestLog.count({
      where: { businessId, createdAt: { gte: today }, statusCode: 429 },
    }),
  ])

  return { logs, requestsToday, failedToday, rateLimitHits }
}
