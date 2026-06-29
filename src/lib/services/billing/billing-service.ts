import { prisma } from '@/lib/prisma'

export type BillingType = 'PURCHASE' | 'TOPUP' | 'REFUND' | 'CREDIT' | 'DEBIT' | 'COST_ADJUSTMENT'

export interface CreateBillingRecordParams {
  businessId: string
  orderId?: string
  esimId?: string
  invoiceId?: string
  type: BillingType
  amount: number
  cost?: number
  currency?: string
  providerId?: string
  salesAgentId?: string
  description?: string
}

export async function createBillingRecord(params: CreateBillingRecordParams): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const cost = params.cost ?? undefined
    const marginAmount = cost != null ? params.amount - cost : undefined
    const marginPercent = cost != null && params.amount > 0 ? parseFloat(((marginAmount! / params.amount) * 100).toFixed(2)) : undefined

    const record = await prisma.billingRecord.create({
      data: {
        businessId: params.businessId,
        orderId: params.orderId || null,
        esimId: params.esimId || null,
        invoiceId: params.invoiceId || null,
        type: params.type,
        amount: params.amount,
        cost: cost ?? null,
        marginAmount: marginAmount ?? null,
        marginPercent: marginPercent ?? null,
        currency: params.currency || 'USD',
        providerId: params.providerId || null,
        salesAgentId: params.salesAgentId || null,
        description: params.description || null,
      },
    })

    return { success: true, id: record.id }
  } catch (e: any) {
    return { success: false, error: e.message || 'Failed to create billing record' }
  }
}

export async function getBillingStats(filters?: {
  startDate?: Date
  endDate?: Date
  providerId?: string
  businessId?: string
  salesAgentId?: string
}) {
  const where: any = {}
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }
  if (filters?.providerId) where.providerId = filters.providerId
  if (filters?.businessId) where.businessId = filters.businessId
  if (filters?.salesAgentId) where.salesAgentId = filters.salesAgentId

  const records = await prisma.billingRecord.findMany({ where })

  const revenue = records.filter(r => ['PURCHASE', 'TOPUP'].includes(r.type)).reduce((s, r) => s + Number(r.amount), 0)
  const refunds = records.filter(r => r.type === 'REFUND').reduce((s, r) => s + Number(r.amount), 0)
  const costs = records.filter(r => r.cost != null).reduce((s, r) => s + Number(r.cost), 0)
  const grossProfit = records.filter(r => r.marginAmount != null).reduce((s, r) => s + Number(r.marginAmount), 0)
  const netRevenue = revenue - refunds

  // Revenue by type
  const byType: Record<string, number> = {}
  for (const r of records) {
    byType[r.type] = (byType[r.type] || 0) + Number(r.amount)
  }

  return {
    totalRecords: records.length,
    revenue,
    refunds,
    netRevenue,
    costs,
    grossProfit,
    profitMargin: revenue > 0 ? parseFloat(((grossProfit / revenue) * 100).toFixed(2)) : 0,
    byType,
  }
}

export async function getRevenueByProvider(filters?: { startDate?: Date; endDate?: Date }) {
  const where: any = { type: { in: ['PURCHASE', 'TOPUP'] } }
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  const records = await prisma.billingRecord.findMany({
    where,
    include: { provider: { select: { name: true } } },
  })

  const byProvider: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {}
  for (const r of records) {
    const key = r.provider?.name || 'Unknown'
    if (!byProvider[key]) byProvider[key] = { revenue: 0, cost: 0, profit: 0, count: 0 }
    byProvider[key].revenue += Number(r.amount)
    if (r.cost) byProvider[key].cost += Number(r.cost)
    if (r.marginAmount) byProvider[key].profit += Number(r.marginAmount)
    byProvider[key].count++
  }

  return Object.entries(byProvider).map(([name, data]) => ({
    name,
    ...data,
    marginPercent: data.revenue > 0 ? parseFloat(((data.profit / data.revenue) * 100).toFixed(2)) : 0,
  })).sort((a, b) => b.revenue - a.revenue)
}

export async function getRevenueByBusiness(filters?: { startDate?: Date; endDate?: Date }) {
  const where: any = { type: { in: ['PURCHASE', 'TOPUP'] } }
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  const records = await prisma.billingRecord.findMany({
    where,
    include: {
      business: { select: { name: true } },
      salesAgent: { include: { user: { select: { name: true } } } },
    },
  })

  const byBusiness: Record<string, { revenue: number; cost: number; profit: number; count: number; salesAgent?: string }> = {}
  for (const r of records) {
    const key = r.business.name
    if (!byBusiness[key]) byBusiness[key] = { revenue: 0, cost: 0, profit: 0, count: 0 }
    byBusiness[key].revenue += Number(r.amount)
    if (r.cost) byBusiness[key].cost += Number(r.cost)
    if (r.marginAmount) byBusiness[key].profit += Number(r.marginAmount)
    byBusiness[key].count++
    if (r.salesAgent?.user?.name) byBusiness[key].salesAgent = r.salesAgent.user.name
  }

  return Object.entries(byBusiness).map(([name, data]) => ({
    name,
    ...data,
    marginPercent: data.revenue > 0 ? parseFloat(((data.profit / data.revenue) * 100).toFixed(2)) : 0,
  })).sort((a, b) => b.revenue - a.revenue)
}

export async function getRevenueBySalesAgent(filters?: { startDate?: Date; endDate?: Date }) {
  const where: any = { type: { in: ['PURCHASE', 'TOPUP'] }, salesAgentId: { not: null } }
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  const records = await prisma.billingRecord.findMany({
    where,
    include: { salesAgent: { include: { user: { select: { name: true } } } } },
  })

  const byAgent: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {}
  for (const r of records) {
    const key = r.salesAgent?.user?.name || 'Unassigned'
    if (!byAgent[key]) byAgent[key] = { revenue: 0, cost: 0, profit: 0, count: 0 }
    byAgent[key].revenue += Number(r.amount)
    if (r.cost) byAgent[key].cost += Number(r.cost)
    if (r.marginAmount) byAgent[key].profit += Number(r.marginAmount)
    byAgent[key].count++
  }

  return Object.entries(byAgent).map(([name, data]) => ({
    name,
    ...data,
    marginPercent: data.revenue > 0 ? parseFloat(((data.profit / data.revenue) * 100).toFixed(2)) : 0,
  })).sort((a, b) => b.revenue - a.revenue)
}
