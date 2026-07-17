'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { TelnaConnector } from '@/lib/providers/connectors/telna-connector'

function isTelnaConnector(c: unknown): c is TelnaConnector {
  return c !== null && typeof c === 'object' && 'listCountries' in c && 'getCompany' in c
}

export async function telnaListCountries(providerId: string, count?: number, offset?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.listCountries(count, offset)
}

export async function telnaGetCompany(providerId: string, companyId: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.getCompany(companyId)
}

export async function telnaListInventories(providerId: string, company?: number, count?: number, offset?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.listInventories(company, count, offset)
}

export async function telnaListGroups(providerId: string, inventoryId?: number, company?: number, count?: number, offset?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.listGroups(inventoryId, company, count, offset)
}

export async function telnaGetWallet(providerId: string, walletId: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.getWallet(walletId)
}

export async function telnaListPackageTemplates(providerId: string, inventoryId?: number, count?: number, offset?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.listPackageTemplates(inventoryId, count, offset)
}

export async function telnaGetPackageTemplate(providerId: string, packageTemplateId: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.getPackageTemplate(packageTemplateId)
}

export async function telnaMapPackageTemplate(providerId: string, packageTemplateId: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  const detail = await connector.getPackageTemplate(packageTemplateId)
  if (!detail.success || !detail.data) {
    return { success: false, error: detail.error }
  }

  const { mapTelnaPackageTemplate } = await import('@/lib/providers/mappers/telna-template-mapper')
  const mapped = mapTelnaPackageTemplate(detail.data.template)
  console.log(`[TELNA_TEMPLATE_MAPPING] templateId=${packageTemplateId} mapped=true warningCount=${mapped.warnings.length}`)

  return { success: true, data: mapped }
}

export async function telnaListSimRegistries(providerId: string, inventoryId?: number, groupId?: number, status?: string, iccid?: string, imsi?: string, count?: number, offset?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.listSimRegistries(inventoryId, groupId, status, iccid, imsi, count, offset)
}

export async function telnaGetSimRegistry(providerId: string, iccid: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  return connector.getSimRegistry(iccid)
}

export async function telnaMapSimRegistry(providerId: string, iccid: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const connector = await buildConnectorFromProvider(providerId)
  if (!connector) throw new Error('Provider not found')
  if (!isTelnaConnector(connector)) throw new Error('Provider does not support Telna discovery')

  const detail = await connector.getSimRegistry(iccid)
  if (!detail.success || !detail.data) {
    return { success: false, error: detail.error }
  }

  const { mapTelnaSimRegistry } = await import('@/lib/providers/mappers/telna-sim-mapper')
  const mapped = mapTelnaSimRegistry(detail.data.sim)
  console.log(`[TELNA_SIM_MAPPING] iccid=${iccid} mapped=true providerStatus=${mapped.providerStatus} normalizedStatus=${mapped.normalizedStatus}`)

  return { success: true, data: mapped }
}
