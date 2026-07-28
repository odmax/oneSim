'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getSystemHealth, getProviderHealth, getPipelineMetrics, getSystemMetrics, getAlerts, getRunningJobs, getErrors } from '@/lib/services/operations-monitoring'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
}

export async function getHealthAction() { await requireAdmin(); return getSystemHealth() }
export async function getProviderHealthAction() { await requireAdmin(); return getProviderHealth() }
export async function getPipelineMetricsAction() { await requireAdmin(); return getPipelineMetrics() }
export async function getSystemMetricsAction() { await requireAdmin(); return getSystemMetrics() }
export async function getAlertsAction() { await requireAdmin(); return getAlerts() }
export async function getRunningJobsAction() { await requireAdmin(); return getRunningJobs() }
export async function getErrorsAction(params: { providerId?: string; type?: string; page?: number }) {
  await requireAdmin()
  return getErrors(params)
}
