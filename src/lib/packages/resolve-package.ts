import { prisma } from '@/lib/prisma'

export interface PackageIdentifier {
  packageId?: string
  sku?: string
  packageCode?: string
}

export interface PackageResolution {
  package: any
  resolvedBy: 'packageId' | 'sku' | 'packageCode'
  provider: { id: string; name: string; type: string } | null
  identifier: string
}

export async function resolvePackageIdentifier(input: PackageIdentifier, opts?: { isActive?: boolean }): Promise<PackageResolution | null> {
  const activeFilter = opts?.isActive !== false ? { isActive: true } : {}

  // Priority 1: packageId
  if (input.packageId) {
    const pkg = await prisma.eSIMPackage.findUnique({
      where: { id: input.packageId, ...activeFilter },
    })
    if (pkg) {
      const provider = pkg.providerId
        ? await prisma.provider.findUnique({ where: { id: pkg.providerId }, select: { id: true, name: true, type: true } })
        : null
      return { package: pkg, resolvedBy: 'packageId', provider, identifier: input.packageId }
    }
  }

  // Priority 2: sku
  if (input.sku) {
    const pkg = await prisma.eSIMPackage.findUnique({
      where: { sku: input.sku, ...activeFilter },
    })
    if (pkg) {
      const provider = pkg.providerId
        ? await prisma.provider.findUnique({ where: { id: pkg.providerId }, select: { id: true, name: true, type: true } })
        : null
      return { package: pkg, resolvedBy: 'sku', provider, identifier: input.sku }
    }
  }

  // Priority 3: packageCode
  if (input.packageCode) {
    const pkg = await prisma.eSIMPackage.findUnique({
      where: { packageCode: input.packageCode, ...activeFilter },
    })
    if (pkg) {
      const provider = pkg.providerId
        ? await prisma.provider.findUnique({ where: { id: pkg.providerId }, select: { id: true, name: true, type: true } })
        : null
      return { package: pkg, resolvedBy: 'packageCode', provider, identifier: input.packageCode }
    }
  }

  return null
}

export function generateSku(name: string, dataGB: number, validityDays: number, providerCode?: string): string {
  const prefix = providerCode ? providerCode.toUpperCase().replace(/\s+/g, '-') : 'ONESIM-AFRICA'
  const dataStr = `${dataGB}GB`
  const validityStr = `${validityDays}D`
  const namePart = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 15)
  return `${prefix}-${dataStr}-${validityStr}${namePart ? '-' + namePart : ''}`
}

export function generatePackageCode(dataGB: number, validityDays: number): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  return `PKG-${dataGB}GB-${validityDays}D-${timestamp}`
}
