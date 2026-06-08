'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { DEFAULT_PERMISSIONS } from '@/lib/auth/admin-permissions'
import { handlePrismaError, handleServerActionError } from '@/lib/errors/handle-prisma-error'

export async function createAdminUser(formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
    const admin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
    if (!admin || admin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

    const name = formData.get('name') as string
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    const role = formData.get('role') as string
    const permissionsRaw = formData.get('permissions') as string
    const isActive = formData.get('isActive') === 'on'

    if (!name || !email || !password || !role) redirect('/admin/users/new?error=All+required+fields+must+be+filled')
    if (password.length < 8) redirect('/admin/users/new?error=Password+must+be+at+least+8+characters')

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) redirect('/admin/users/new?error=Email+already+in+use')

    let permissions: string[]
    try { permissions = JSON.parse(permissionsRaw) } catch { permissions = DEFAULT_PERMISSIONS[role] || [] }

    const passwordHash = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: { name, email, passwordHash, role: 'INTERNAL_ADMIN', isActive: true },
    })
    await prisma.internalAdmin.create({
      data: { userId: user.id, role: role as any, permissions, isActive },
    })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'ADMIN_CREATED', entity: 'InternalAdmin', entityId: user.id, details: `Admin user created: ${name} (${email}) as ${role}` },
    })
    revalidatePath('/admin/users')
    redirect('/admin/users?success=Admin+user+created')
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to create admin user')
    redirect(`/admin/users/new?error=${encodeURIComponent(message)}`)
  }
}

export async function updateAdminUser(adminId: string, formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
    const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
    if (!currentAdmin || currentAdmin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

    const target = await prisma.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
    if (!target) redirect('/admin/users?error=User+not+found')

    const role = formData.get('role') as string || target.role
    const permissionsRaw = formData.get('permissions') as string
    const isActive = formData.get('isActive') === 'on'

    if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      const superAdminCount = await prisma.internalAdmin.count({ where: { role: 'SUPER_ADMIN' } })
      if (superAdminCount <= 1) redirect(`/admin/users/${adminId}/edit?error=Cannot+remove+last+SUPER_ADMIN`)
    }

    let permissions: string[]
    try { permissions = JSON.parse(permissionsRaw) } catch { permissions = DEFAULT_PERMISSIONS[role] || [] }

    await prisma.internalAdmin.update({ where: { id: adminId }, data: { role: role as any, permissions, isActive } })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'ADMIN_UPDATED', entity: 'InternalAdmin', entityId: adminId, details: `Admin updated: ${target.user.name} → role: ${role}, active: ${isActive}` },
    })

    revalidatePath('/admin/users')
    redirect('/admin/users?success=Admin+user+updated')
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to update admin user')
    redirect(`/admin/users/${adminId}/edit?error=${encodeURIComponent(message)}`)
  }
}

export async function toggleAdminStatus(adminId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
    const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
    if (!currentAdmin || currentAdmin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

    if (adminId === currentAdmin.id) redirect('/admin/users?error=Cannot+modify+yourself')

    const target = await prisma.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
    if (!target) redirect('/admin/users?error=User+not+found')

    const newActive = !target.isActive
    await prisma.internalAdmin.update({ where: { id: adminId }, data: { isActive: newActive } })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: newActive ? 'ADMIN_REACTIVATED' : 'ADMIN_SUSPENDED', entity: 'InternalAdmin', entityId: adminId, details: `Admin ${newActive ? 'reactivated' : 'suspended'}: ${target.user.name}` },
    })

    revalidatePath('/admin/users')
    redirect(`/admin/users?success=Admin+${newActive ? 'reactivated' : 'suspended'}`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to toggle admin status')
    redirect(`/admin/users?error=${encodeURIComponent(message)}`)
  }
}

export async function deleteAdminUser(adminId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const currentAdmin = await prisma.internalAdmin.findUnique({ where: { userId: session.user.id } })
  if (!currentAdmin || currentAdmin.role !== 'SUPER_ADMIN') redirect('/admin?error=unauthorized')

  if (adminId === currentAdmin.id) redirect('/admin/users?error=Cannot+delete+yourself')

  try {
    const target = await prisma.internalAdmin.findUnique({ where: { id: adminId }, include: { user: true } })
    if (!target) redirect('/admin/users?error=User+not+found')

    if (target.role === 'SUPER_ADMIN') {
      const count = await prisma.internalAdmin.count({ where: { role: 'SUPER_ADMIN' } })
      if (count <= 1) redirect('/admin/users?error=Cannot+delete+last+SUPER_ADMIN')
    }

    await prisma.internalAdmin.delete({ where: { id: adminId } })
    await prisma.user.update({ where: { id: target.userId }, data: { isActive: false } })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'ADMIN_DELETED', entity: 'InternalAdmin', entityId: adminId, details: `Admin deleted: ${target.user.name}` },
    })

    revalidatePath('/admin/users')
    redirect('/admin/users?success=Admin+user+deleted')
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { handleServerActionError } = await import('@/lib/errors/handle-prisma-error')
    handleServerActionError(error, '/admin/users', 'delete_failed')
  }
}
