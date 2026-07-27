import { prisma } from '@/lib/prisma'
import { enqueueJob, processDueJobs } from './queue'

export interface ProviderJobPayload {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  totalAmount: number
  operation: string // 'activation' | 'topup' | etc.
}

export class ProviderJobEngine {
  /**
   * Create a provider operation job for background processing.
   */
  static async createJob(payload: ProviderJobPayload, maxAttempts = 10, runAt?: Date): Promise<string> {
    const job = await enqueueJob('PROVIDER_OPERATION' as any, { ...payload, attempts: 0 }, runAt || new Date(Date.now() + 30000), maxAttempts)
    return job.id
  }

  /**
   * Process due provider operation jobs.
   */
  static async processDueJobs(limit = 10): Promise<Array<{ id: string; status: string; error?: string }>> {
    const results = await processDueJobs(limit)
    return results
  }

  /**
   * Get jobs for an order.
   */
  static async getJobsForOrder(orderId: string) {
    return prisma.backgroundJob.findMany({
      where: { type: 'PROVIDER_OPERATION' as any, payload: { path: ['orderId'], equals: orderId } },
      orderBy: { createdAt: 'desc' },
    })
  }

  /**
   * Cancel pending provider jobs for an order.
   */
  static async cancelJobsForOrder(orderId: string) {
    const jobs = await prisma.backgroundJob.findMany({
      where: {
        type: 'PROVIDER_OPERATION' as any,
        status: 'PENDING',
        payload: { path: ['orderId'], equals: orderId },
      },
    })
    for (const job of jobs) {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: 'FAILED' as any, lastError: 'Order cancelled' },
      })
    }
  }
}
