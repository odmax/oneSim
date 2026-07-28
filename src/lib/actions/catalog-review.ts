'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { getReviewStats, getReviewItems } from '@/lib/catalog/catalog-review-service'
import { applyReviewDecision, bulkApplyReviewDecisions } from '@/lib/catalog/catalog-review-apply-service'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  return session.user.id
}

export async function getReviewDashboardData(params: {
  status?: string
  providerId?: string
  suggestedAction?: string
  search?: string
  page?: number
}) {
  await requireAdmin()
  const [stats, reviewData] = await Promise.all([
    getReviewStats(),
    getReviewItems(params),
  ])
  return { stats, ...reviewData }
}

export async function approveReviewItem(itemId: string, note?: string) {
  const userId = await requireAdmin()
  const result = await applyReviewDecision(itemId, userId, 'APPROVE', note)
  revalidatePath('/admin/catalog-review')
  return result
}

export async function rejectReviewItem(itemId: string, note?: string) {
  const userId = await requireAdmin()
  const result = await applyReviewDecision(itemId, userId, 'REJECT', note)
  revalidatePath('/admin/catalog-review')
  return result
}

export async function ignoreReviewItem(itemId: string, note?: string) {
  const userId = await requireAdmin()
  const result = await applyReviewDecision(itemId, userId, 'IGNORE', note)
  revalidatePath('/admin/catalog-review')
  return result
}

export async function archiveReviewItem(itemId: string, note?: string) {
  const userId = await requireAdmin()
  const result = await applyReviewDecision(itemId, userId, 'ARCHIVE', note)
  revalidatePath('/admin/catalog-review')
  return result
}

export async function bulkApproveItems(itemIds: string[]) {
  const userId = await requireAdmin()
  const result = await bulkApplyReviewDecisions(itemIds, userId, 'APPROVE')
  revalidatePath('/admin/catalog-review')
  return result
}

export async function bulkRejectItems(itemIds: string[]) {
  const userId = await requireAdmin()
  const result = await bulkApplyReviewDecisions(itemIds, userId, 'REJECT')
  revalidatePath('/admin/catalog-review')
  return result
}
