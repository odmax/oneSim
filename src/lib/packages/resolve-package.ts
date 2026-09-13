import { prisma } from '@/lib/prisma'
import { derivePublicSku, PUBLIC_SKU_PREFIX } from '@/lib/catalog/public-sku'

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

    // Backward-compatible fallback: the PUBLIC (provider-neutral) SKU shown to
    // clients is now derived deterministically and may differ from a legacy
    // persisted SKU. Allow clients that use the displayed public SKU to still
    // resolve their package without ever exposing provider identity. Exact,
    // unique match required — ambiguous matches fail closed.
    if (typeof input.sku === 'string' && input.sku.toUpperCase().startsWith(PUBLIC_SKU_PREFIX)) {
      const candidates = await prisma.eSIMPackage.findMany({
        where: { ...activeFilter, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
        select: {
          id: true, providerPackageId: true, dataGB: true, validityDays: true,
          providerPackage: { select: { country: true, region: true } },
        },
      })
      // Geography lives on ProviderPackage, but derivePublicSku reads the FLAT
      // country/region. Candidates must be flattened exactly like the export/
      // public-catalog serializers do, otherwise a package whose providerPackage
      // carries a real country (e.g. USA) derives OS-XX-… here while the client
      // was shown OS-USA-… and resolution fails. Previously only XX-geography
      // packages matched, which is why non-empty-geography packages failed.
      const matches = candidates.filter(c =>
        derivePublicSku({
          id: c.id,
          providerPackageId: c.providerPackageId,
          country: c.providerPackage?.country,
          region: c.providerPackage?.region,
          dataGB: c.dataGB,
          validityDays: c.validityDays,
        }) === input.sku,
      )
      if (matches.length === 1) {
        const pkg = await prisma.eSIMPackage.findUnique({ where: { id: matches[0].id } })
        if (pkg) {
          const provider = pkg.providerId
            ? await prisma.provider.findUnique({ where: { id: pkg.providerId }, select: { id: true, name: true, type: true } })
            : null
          return { package: pkg, resolvedBy: 'sku', provider, identifier: input.sku }
        }
      }
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

/**
 * Provider-neutral SKU generator for template/imported packages. The upstream
 * provider code is NEVER embedded in the public SKU. `providerCode` is retained
 * in the signature only for call-compatibility and is ignored.
 */
export function generateSku(name: string, dataGB: number, validityDays: number, _providerCode?: string): string {
  const dataStr = `${dataGB}GB`
  const validityStr = `${validityDays}D`
  const namePart = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 15)
  return `OS-${dataStr}-${validityStr}${namePart ? '-' + namePart : ''}`
}

export function generatePackageCode(dataGB: number, validityDays: number): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  return `PKG-${dataGB}GB-${validityDays}D-${timestamp}`
}
