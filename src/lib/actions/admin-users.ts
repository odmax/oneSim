'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { InternalAdminRole } from '@prisma/client'
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS } from '@/lib/auth/admin-permissions'
import { isSuperAdminRole } from '@/lib/auth/permissions'
import { handlePrismaError, handleServerActionError } from '@/lib/errors/handle-prisma-error'

const VALID_ROLE_SET: ReadonlySet<string> = new Set(Object.values(InternalAdminRole))
const VALID_PERMISSION_SET: ReadonlySet<string> = new Set(ADMIN_PERMISSIONS.map((p) => p.id))

type FieldValues = { name: string; email: string; role: string; isActive: boolean; password?: string; permissions: string[] }

function cleanString(value: FormDataEntryValue | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validRole(role: string): boolean {
  return VALID_ROLE_SET.has(role)
}

/** Server-side validation: never trust arbitrary permission strings. */
function sanitizePermissions(role: string, permissionsRaw: string | null | undefined): string[] {
  if (isSuperAdminRole(role)) return [...VALID_PERMISSION_SET]
  let parsed: unknown
  try {
    parsed = permissionsRaw ? JSON.parse(permissionsRaw) : undefined
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed)) {
    return (DEFAULT_PERMISSIONS[role] || []).filter((p) => VALID_PERMISSION_SET.has(p))
  }
  return parsed.filter((p): p is string => VALID_PERMISSION_SET.has(p))
}

async function audit(userId: string, action: string, entityId: string, details: string): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { userId, action, entity: 'InternalAdmin', entityId, details } })
  } catch (e) {
    console.error(`admin-users: audit failed (non-fatal): action=${action}`, e)
  }
}

/** The active SUPER_ADMIN acting on admin records (DB-backed, session role ignored). */
async function requireSuperAdminAction() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const admin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!admin || !admin.isActive || admin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')
  return { session, admin }
}

async function activeSuperAdminCount(): Promise<number> {
  return prisma.internalAdmin.count({
    where: { role: 'SUPER_ADMIN', isActive: true, user: { isActive: true } },
  })
}

const SUPERVISOR_CONFLICT_ERROR = 'Another admin change is in progress; the last active SUPER_ADMIN is protected. Please retry.'

/**
 * Run an admin mutation inside ONE Serializable transaction so the
 * last-active-SUPER_ADMIN count-guard and the demotion/deactivation write are
 * atomic. redirect() inside the closure aborts the transaction. On a Prisma
 * serialization conflict (P2034) we fail SAFE (no blind retry, no writes) so at
 * least one active SUPER_ADMIN always remains.
 */
async function runAdminMutationTx<T>(fn: (tx: any) => Promise<T>): Promise<T | { serializationConflict: true }> {
  try {
    return await prisma.$transaction(fn, { isolationLevel: 'Serializable' as any })
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    if (error?.code === 'P2034') return { serializationConflict: true }
    throw error
  }
}

function parseCreateFields(formData: FormData): FieldValues {
  const name = cleanString(formData.get('name'))
  const email = cleanString(formData.get('email'))
  const password = cleanString(formData.get('password'))
  const role = cleanString(formData.get('role'))
  const permissionsRaw = formData.get('permissions') as string | null
  const isActive = formData.get('isActive') === 'on'
  return { name, email, role, isActive, password, permissions: sanitizePermissions(role, permissionsRaw) }
}

export async function createAdminUser(formData: FormData) {
  try {
    const { session, admin } = await requireSuperAdminAction()
    const fields = parseCreateFields(formData)

    if (!fields.name || !fields.email || !fields.password || !validRole(fields.role)) {
      redirect('/admin/users/new?error=All+required+fields+must+be+filled')
    }
    if (fields.password.length < 8) redirect('/admin/users/new?error=Password+must+be+at+least+8+characters')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) redirect('/admin/users/new?error=Invalid+email+address')

    const passwordHash = await bcrypt.hash(fields.password, 12)
    const lowerEmail = fields.email

    // Never weaken global email uniqueness: only the legacy-deleted-admin case
    // (inactive INTERNAL_ADMIN User with NO InternalAdmin row) is reusable.
    const result = await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({ where: { email: lowerEmail } })
      if (existingUser) {
        if (existingUser.role !== 'INTERNAL_ADMIN' || existingUser.isActive) {
          return { kind: 'DUPLICATE' as const }
        }
        const legacyAdmin = await tx.internalAdmin.findUnique({ where: { userId: existingUser.id } })
        if (legacyAdmin) return { kind: 'DUPLICATE' as const }
        await tx.user.update({
          where: { id: existingUser.id },
          data: { name: fields.name, passwordHash, isActive: true },
        })
        const created = await tx.internalAdmin.create({
          data: { userId: existingUser.id, role: fields.role as InternalAdminRole, permissions: fields.permissions, isActive: fields.isActive },
        })
        return { kind: 'RESTORED' as const, adminId: created.id, userId: existingUser.id }
      }
      const user = await tx.user.create({
        data: { name: fields.name, email: lowerEmail, passwordHash, role: 'INTERNAL_ADMIN', isActive: true },
      })
      const created = await tx.internalAdmin.create({
        data: { userId: user.id, role: fields.role as InternalAdminRole, permissions: fields.permissions, isActive: fields.isActive },
      })
      return { kind: 'CREATED' as const, adminId: created.id, userId: user.id }
    })

    if (result.kind === 'DUPLICATE') {
      redirect('/admin/users/new?error=Email+already+in+use')
    }

    const details =
      result.kind === 'RESTORED'
        ? `Admin restored: ${fields.name} (${fields.email}) as ${fields.role}`
        : `Admin user created: ${fields.name} (${fields.email}) as ${fields.role}`
    // entityId identifies the TARGET admin record (created/restored), never the
    // acting admin; the actor stays in userId.
    await audit(session.user.id, result.kind === 'RESTORED' ? 'ADMIN_RESTORED' : 'ADMIN_CREATED', result.adminId, details)

    revalidatePath('/admin/users')
    redirect(`/admin/users?success=${result.kind === 'RESTORED' ? 'Admin+account+restored' : 'Admin+user+created'}`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    // Concurrent duplicate-email create: the USER row is globally unique, so a
    // race surfaces as P2002 — never confuse it with a success.
    const { message, code } = handlePrismaError(error, 'Failed to create admin user')
    redirect(`/admin/users/new?error=${encodeURIComponent(code === 'P2002' ? 'Email already in use' : message)}`)
  }
}

export async function updateAdminUser(adminId: string, formData: FormData) {
  try {
    const { session } = await requireSuperAdminAction()

    const role = cleanString(formData.get('role'))
    const permissionsRaw = formData.get('permissions') as string | null
    const isActive = formData.get('isActive') === 'on'
    if (!validRole(role)) redirect(`/admin/users/${adminId}/edit?error=Invalid+role`)
    const permissions = sanitizePermissions(role, permissionsRaw)

    // The last-SUPER_ADMIN guard and the writes run in ONE Serializable
    // transaction; a concurrent change fails safe instead of removing the last
    // active SUPER_ADMIN.
    const outcome = await runAdminMutationTx(async (tx) => {
      const target = await tx.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
      if (!target) redirect('/admin/users?error=User+not+found')

      // Self-protection: cannot demote or deactivate yourself.
      if (target.userId === session.user.id) {
        if (role !== 'SUPER_ADMIN' || !isActive) redirect(`/admin/users/${adminId}/edit?error=Cannot+demote+or+deactivate+yourself`)
      }

      // Protect the last active SUPER_ADMIN from demotion/deactivation.
      const diminishingTarget = target.role === 'SUPER_ADMIN' && (role !== 'SUPER_ADMIN' || !isActive)
      if (diminishingTarget) {
        const count = await tx.internalAdmin.count({
          where: { role: 'SUPER_ADMIN', isActive: true, user: { isActive: true } },
        })
        if (count <= 1) redirect(`/admin/users/${adminId}/edit?error=Cannot+remove+last+SUPER_ADMIN`)
      }

      await tx.internalAdmin.update({ where: { id: adminId }, data: { role: role as InternalAdminRole, permissions, isActive } })
      await tx.user.update({ where: { id: target.userId }, data: { isActive } })
      return { name: target.user.name }
    })

    if (outcome && 'serializationConflict' in outcome) {
      redirect(`/admin/users/${adminId}/edit?error=${encodeURIComponent(SUPERVISOR_CONFLICT_ERROR)}`)
    }

    await audit(
      session.user.id,
      'ADMIN_UPDATED',
      adminId,
      `Admin updated: ${outcome.name} → role: ${role}, active: ${isActive}, permissions: ${permissions.length}`,
    )

    revalidatePath('/admin/users')
    revalidatePath(`/admin/users/${adminId}`)
    redirect('/admin/users?success=Admin+user+updated')
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to update admin user')
    redirect(`/admin/users/${adminId}/edit?error=${encodeURIComponent(message)}`)
  }
}

export async function toggleAdminStatus(adminId: string) {
  try {
    const { session, admin } = await requireSuperAdminAction()
    if (adminId === admin.id) redirect('/admin/users?error=Cannot+modify+yourself')

    const outcome = await runAdminMutationTx(async (tx) => {
      const target = await tx.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
      if (!target) redirect('/admin/users?error=User+not+found')

      const newActive = !target.isActive
      if (!newActive && target.role === 'SUPER_ADMIN') {
        const count = await tx.internalAdmin.count({
          where: { role: 'SUPER_ADMIN', isActive: true, user: { isActive: true } },
        })
        if (count <= 1) redirect('/admin/users?error=Cannot+suspend+last+SUPER_ADMIN')
      }

      await tx.internalAdmin.update({ where: { id: adminId }, data: { isActive: newActive } })
      await tx.user.update({ where: { id: target.userId }, data: { isActive: newActive } })
      return { newActive, name: target.user.name }
    })

    if (outcome && 'serializationConflict' in outcome) {
      redirect(`/admin/users?error=${encodeURIComponent(SUPERVISOR_CONFLICT_ERROR)}`)
    }

    await audit(session.user.id, outcome.newActive ? 'ADMIN_REACTIVATED' : 'ADMIN_SUSPENDED', adminId, `Admin ${outcome.newActive ? 'reactivated' : 'suspended'}: ${outcome.name}`)

    revalidatePath('/admin/users')
    redirect(`/admin/users?success=Admin+${outcome.newActive ? 'reactivated' : 'suspended'}`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to toggle admin status')
    redirect(`/admin/users?error=${encodeURIComponent(message)}`)
  }
}

/**
 * Audited deactivation (replaces the old hard delete). Both the User and the
 * InternalAdmin rows are KEPT and set to inactive so the account (and email)
 * remain reusable through normal reactivation or the create-restore path.
 */
export async function deactivateAdminUser(adminId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN' || !session.user.id) redirect('/login')
  const actor = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!actor || !actor.isActive || actor.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

  if (adminId === actor.id) redirect('/admin/users?error=Cannot+deactivate+yourself')

  try {
    // Keep both rows; deactivate the account so the email stays globally unique
    // yet no longer signs in, and the admin record remains restorable. The
    // last-SUPER_ADMIN guard and the writes are one Serializable transaction.
    const outcome = await runAdminMutationTx(async (tx) => {
      const target = await tx.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
      if (!target) redirect('/admin/users?error=User+not+found')

      if (target.role === 'SUPER_ADMIN') {
        const count = await tx.internalAdmin.count({
          where: { role: 'SUPER_ADMIN', isActive: true, user: { isActive: true } },
        })
        if (count <= 1) redirect('/admin/users?error=Cannot+deactivate+last+SUPER_ADMIN')
      }

      await tx.internalAdmin.update({ where: { id: adminId }, data: { isActive: false } })
      await tx.user.update({ where: { id: target.userId }, data: { isActive: false } })
      return { name: target.user.name }
    })

    if (outcome && 'serializationConflict' in outcome) {
      redirect(`/admin/users?error=${encodeURIComponent(SUPERVISOR_CONFLICT_ERROR)}`)
    }

    await audit(session.user.id, 'ADMIN_DEACTIVATED', adminId, `Admin deactivated: ${outcome.name}`)

    revalidatePath('/admin/users')
    redirect('/admin/users?success=Admin+account+deactivated')
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    handleServerActionError(error, '/admin/users', 'deactivate_failed')
  }
}