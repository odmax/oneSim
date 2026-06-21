'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'

const CHECKLIST = [
  // Connectivity
  { category: 'CONNECTIVITY', checkKey: 'test_connection', label: 'Test Connection', isCritical: true },
  { category: 'CONNECTIVITY', checkKey: 'auth_success', label: 'Authentication Success', isCritical: true },
  // Catalog
  { category: 'CATALOG', checkKey: 'sync_plans', label: 'Sync Plans', isCritical: true },
  { category: 'CATALOG', checkKey: 'imported_plans_created', label: 'Imported Plans Created', isCritical: true },
  { category: 'CATALOG', checkKey: 'no_duplicate_plans', label: 'No Duplicate Plans', isCritical: false },
  // Pricing
  { category: 'PRICING', checkKey: 'cost_override_works', label: 'Cost Override Works', isCritical: false },
  { category: 'PRICING', checkKey: 'cheapest_engine_works', label: 'Cheapest Engine Works', isCritical: false },
  { category: 'PRICING', checkKey: 'csv_export_works', label: 'CSV Export Works', isCritical: false },
  { category: 'PRICING', checkKey: 'csv_import_works', label: 'CSV Import Works', isCritical: false },
  // Publishing
  { category: 'PUBLISHING', checkKey: 'mark_ready_works', label: 'Mark Ready Works', isCritical: false },
  { category: 'PUBLISHING', checkKey: 'publish_works', label: 'Publish Works', isCritical: true },
  { category: 'PUBLISHING', checkKey: 'catalog_visibility_works', label: 'Catalog Visibility Works', isCritical: false },
  // Provisioning
  { category: 'PROVISIONING', checkKey: 'purchase_esim_works', label: 'Purchase eSIM Works', isCritical: true },
  { category: 'PROVISIONING', checkKey: 'qr_code_retrieval_works', label: 'QR Code Retrieval Works', isCritical: false },
  // Features
  { category: 'FEATURES', checkKey: 'usage_lookup_works', label: 'Usage Lookup Works', isCritical: false },
  { category: 'FEATURES', checkKey: 'renewal_works', label: 'Renewal Works', isCritical: false },
  { category: 'FEATURES', checkKey: 'top_up_works', label: 'Top-Up Works', isCritical: false },
  { category: 'FEATURES', checkKey: 'inventory_works', label: 'Inventory Works', isCritical: false },
  // Commercial
  { category: 'COMMERCIAL', checkKey: 'revenue_calc_verified', label: 'Revenue Calculation Verified', isCritical: true },
  { category: 'COMMERCIAL', checkKey: 'profit_calc_verified', label: 'Profit Calculation Verified', isCritical: true },
  // Operations
  { category: 'OPERATIONS', checkKey: 'audit_logs_generated', label: 'Audit Logs Generated', isCritical: false },
  { category: 'OPERATIONS', checkKey: 'monitoring_enabled', label: 'Monitoring Enabled', isCritical: false },
]

const CRITICAL_CATEGORIES = ['CONNECTIVITY', 'CATALOG', 'PROVISIONING', 'COMMERCIAL']

async function getOrCreateAudit(providerId: string) {
  let audit = await prisma.providerAudit.findUnique({
    where: { providerId },
    include: { checks: true },
  })
  if (!audit) {
    audit = await prisma.providerAudit.create({
      data: { providerId },
      include: { checks: true },
    })
  }
  if (audit!.checks.length === 0) {
    const auditId = audit!.id
    await prisma.providerAuditCheck.createMany({
      data: CHECKLIST.map(c => ({
        auditId,
        category: c.category,
        checkKey: c.checkKey,
        label: c.label,
        isCritical: c.isCritical,
        status: 'PENDING',
      })),
    })
    audit = await prisma.providerAudit.findUnique({
      where: { providerId },
      include: { checks: true, notes: { orderBy: { createdAt: 'desc' } } },
    })
  }
  return audit!
}

function computeStatus(checks: { status: string; isCritical: boolean }[]): {
  certificationStatus: string; passCount: number; failCount: number
} {
  const total = checks.length
  const passCount = checks.filter(c => c.status === 'PASS').length
  const failCount = checks.filter(c => c.status === 'FAIL').length
  const hasCriticalFail = checks.some(c => c.status === 'FAIL' && c.isCritical)

  let certificationStatus: string
  if (passCount === 0 && failCount === 0) certificationStatus = 'NOT_STARTED'
  else if (hasCriticalFail) certificationStatus = 'FAILED'
  else if (passCount === total) certificationStatus = 'CERTIFIED'
  else certificationStatus = 'IN_PROGRESS'

  return { certificationStatus, passCount, failCount }
}

export async function getAuditData() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const providers = await prisma.provider.findMany({
    orderBy: { name: 'asc' },
    include: { audits: { include: { checks: true } } },
  })

  // Ensure each provider has an audit with checklist items
  const audits = await Promise.all(providers.map(async p => {
    const audit = await getOrCreateAudit(p.id)
    return {
      provider: { id: p.id, name: p.name, code: p.code, status: p.status, environment: p.environment },
      audit: {
        id: audit.id,
        certificationStatus: '',
        passCount: 0,
        failCount: 0,
        totalChecks: audit.checks.length,
      },
      checks: audit.checks.map(c => ({
        id: c.id, category: c.category, checkKey: c.checkKey, label: c.label,
        status: c.status, isCritical: c.isCritical, notes: c.notes,
        checkedAt: c.checkedAt?.toISOString() || null, checkedBy: c.checkedBy,
      })),
      notes: [],
    }
  }))

  // Compute status for each
  for (const a of audits) {
    const computed = computeStatus(a.checks)
    a.audit.certificationStatus = computed.certificationStatus
    a.audit.passCount = computed.passCount
    a.audit.failCount = computed.failCount
  }

  return audits
}

export async function markAuditCheck(auditId: string, checkId: string, status: 'PASS' | 'FAIL') {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  await prisma.providerAuditCheck.update({
    where: { id: checkId },
    data: { status, checkedAt: new Date(), checkedBy: session.user.email || 'admin' },
  })

  // Recompute certification status
  const audit = await prisma.providerAudit.findUnique({
    where: { id: auditId },
    include: { checks: true },
  })
  if (audit) {
    const computed = computeStatus(audit.checks)
    await prisma.providerAudit.update({
      where: { id: auditId },
      data: {
        certificationStatus: computed.certificationStatus,
        passCount: computed.passCount,
        failCount: computed.failCount,
        totalChecks: audit.checks.length,
        completedAt: computed.certificationStatus === 'CERTIFIED' || computed.certificationStatus === 'FAILED' ? new Date() : null,
      },
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'PROVIDER_AUDIT_CHECK_UPDATED',
      entity: 'ProviderAuditCheck', entityId: checkId,
      details: `Audit check marked as ${status}`,
    },
  })

  revalidatePath('/admin/provider-audit')
}

export async function addAuditNote(auditId: string, content: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  await prisma.providerAuditNote.create({
    data: { auditId, content, authorId: session.user.id },
  })

  revalidatePath('/admin/provider-audit')
}

export async function resetAudit(auditId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  await prisma.providerAuditCheck.updateMany({
    where: { auditId },
    data: { status: 'PENDING', checkedAt: null, checkedBy: null, notes: null },
  })

  await prisma.providerAudit.update({
    where: { id: auditId },
    data: { certificationStatus: 'NOT_STARTED', passCount: 0, failCount: 0, completedAt: null },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'PROVIDER_AUDIT_RESET',
      entity: 'ProviderAudit', entityId: auditId,
      details: 'Audit reset',
    },
  })

  revalidatePath('/admin/provider-audit')
}

export async function generateCertificationReport(auditId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const audit = await prisma.providerAudit.findUnique({
    where: { id: auditId },
    include: {
      provider: { select: { name: true, code: true, environment: true, status: true } },
      checks: true,
      notes: { include: { author: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
    },
  })
  if (!audit) throw new Error('Audit not found')

  const totals = computeStatus(audit.checks)
  const outstanding = audit.checks.filter(c => c.status === 'PENDING')
  const failed = audit.checks.filter(c => c.status === 'FAIL')
  const passed = audit.checks.filter(c => c.status === 'PASS')

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'PROVIDER_AUDIT_REPORT',
      entity: 'ProviderAudit', entityId: auditId,
      details: `Certification report generated for ${audit.provider.name}`,
    },
  })

  return {
    providerName: audit.provider.name,
    providerCode: audit.provider.code,
    environment: audit.provider.environment,
    status: audit.provider.status,
    certificationStatus: totals.certificationStatus,
    passCount: totals.passCount,
    failCount: totals.failCount,
    totalChecks: audit.checks.length,
    passPercent: audit.checks.length > 0 ? Math.round((totals.passCount / audit.checks.length) * 100) : 0,
    failPercent: audit.checks.length > 0 ? Math.round((totals.failCount / audit.checks.length) * 100) : 0,
    passedChecks: passed.map(c => ({ label: c.label, category: c.category })),
    failedChecks: failed.map(c => ({ label: c.label, category: c.category })),
    outstandingChecks: outstanding.map(c => ({ label: c.label, category: c.category })),
    notes: audit.notes.map(n => ({ content: n.content, author: n.author?.name || 'Unknown', createdAt: n.createdAt.toISOString() })),
    generatedAt: new Date().toISOString(),
  }
}
