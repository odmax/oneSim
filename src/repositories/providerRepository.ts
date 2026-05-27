import { prisma } from '@/lib/prisma'
import { encryptCredentials, decryptCredentials } from '@/services/credentialVault'
import type { ProviderConfig, Prisma } from '@prisma/client'

export interface ProviderRecord {
  id: string
  name: string
  slug: string
  baseUrl: string
  authType: string
  credentials: Record<string, string>
  adapterClass: string
  fieldMappings: Record<string, string>
  endpoints: Record<string, { method: string; path: string }>
  webhookConfig: { enabled: boolean; path: string; authType: string; secretEncrypted: string }
  active: boolean
}

function toRecord(row: ProviderConfig): ProviderRecord {
  let creds: Record<string, string> = {}
  try {
    creds = decryptCredentials(row.credentials)
  } catch {
    creds = {}
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    baseUrl: row.baseUrl,
    authType: row.authType,
    credentials: creds,
    adapterClass: row.adapterClass,
    fieldMappings: (row.fieldMappings as Record<string, string>) || {},
    endpoints: (row.endpoints as Record<string, { method: string; path: string }>) || {},
    webhookConfig: (row.webhookConfig as { enabled: boolean; path: string; authType: string; secretEncrypted: string }) || { enabled: false, path: '', authType: '', secretEncrypted: '' },
    active: row.active,
  }
}

function maskRecord(record: ProviderRecord): ProviderRecord {
  const masked: Record<string, string> = {}
  for (const key of Object.keys(record.credentials)) {
    masked[key] = '••••••••'
  }
  return { ...record, credentials: masked }
}

export class ProviderRepository {
  async findBySlug(slug: string): Promise<ProviderRecord | null> {
    const row = await prisma.providerConfig.findUnique({ where: { slug } })
    if (!row || !row.active) return null
    return toRecord(row)
  }

  async findAll(activeOnly = false): Promise<ProviderRecord[]> {
    const where: Prisma.ProviderConfigWhereInput = {}
    if (activeOnly) where.active = true
    const rows = await prisma.providerConfig.findMany({ where, orderBy: { name: 'asc' } })
    return rows.map(toRecord)
  }

  async findAllMasked(activeOnly = false): Promise<ProviderRecord[]> {
    const records = await this.findAll(activeOnly)
    return records.map(maskRecord)
  }

  async findMaskedBySlug(slug: string): Promise<ProviderRecord | null> {
    const record = await this.findBySlug(slug)
    if (!record) return null
    return maskRecord(record)
  }

  async findBySlugRaw(slug: string): Promise<ProviderConfig | null> {
    return prisma.providerConfig.findUnique({ where: { slug } })
  }

  async create(data: Omit<ProviderRecord, 'id'>): Promise<ProviderRecord> {
    const encrypted = encryptCredentials(data.credentials)
    const row = await prisma.providerConfig.create({
      data: {
        name: data.name,
        slug: data.slug,
        baseUrl: data.baseUrl,
        authType: data.authType,
        credentials: encrypted,
        adapterClass: data.adapterClass,
        fieldMappings: data.fieldMappings as any,
        endpoints: data.endpoints as any,
        webhookConfig: data.webhookConfig as any,
        active: data.active,
      },
    })
    return toRecord(row)
  }

  async update(id: string, data: Partial<ProviderRecord>): Promise<ProviderRecord> {
    const updateData: Prisma.ProviderConfigUpdateInput = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.slug !== undefined) updateData.slug = data.slug
    if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl
    if (data.authType !== undefined) updateData.authType = data.authType
    if (data.credentials !== undefined) {
      updateData.credentials = encryptCredentials(data.credentials)
    }
    if (data.adapterClass !== undefined) updateData.adapterClass = data.adapterClass
    if (data.fieldMappings !== undefined) updateData.fieldMappings = data.fieldMappings as any
    if (data.endpoints !== undefined) updateData.endpoints = data.endpoints as any
    if (data.webhookConfig !== undefined) updateData.webhookConfig = data.webhookConfig as any
    if (data.active !== undefined) updateData.active = data.active

    const row = await prisma.providerConfig.update({ where: { id }, data: updateData })
    return toRecord(row)
  }

  async delete(id: string): Promise<void> {
    await prisma.providerConfig.delete({ where: { id } })
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await prisma.providerConfig.update({ where: { id }, data: { active } })
  }
}

export const providerRepo = new ProviderRepository()
