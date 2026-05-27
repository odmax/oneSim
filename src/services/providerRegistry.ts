import type { IProviderAdapter } from '@/adapters/IProviderAdapter'
import { BaseRestAdapter } from '@/adapters/BaseRestAdapter'
import { ProviderRepository } from '@/repositories/providerRepository'
import { ProviderNotFoundError, UnknownAdapterError } from '@/errors/providerErrors'

const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  adapter: IProviderAdapter
  ttl: number
}

export class ProviderRegistry {
  private cache = new Map<string, CacheEntry>()

  constructor(private repo: ProviderRepository) {}

  async resolve(slug: string): Promise<IProviderAdapter> {
    const cached = this.cache.get(slug)
    if (cached && Date.now() < cached.ttl) {
      return cached.adapter
    }

    const record = await this.repo.findBySlug(slug)
    if (!record) {
      throw new ProviderNotFoundError(slug)
    }

    const adapter = this.buildAdapter(record)
    this.cache.set(slug, { adapter, ttl: Date.now() + CACHE_TTL_MS })
    return adapter
  }

  private buildAdapter(record: import('@/repositories/providerRepository').ProviderRecord): IProviderAdapter {
    switch (record.adapterClass) {
      case 'rest_generic':
      case 'rest_custom':
        return new BaseRestAdapter(record)
      default:
        throw new UnknownAdapterError(record.adapterClass)
    }
  }

  invalidate(slug: string): void {
    this.cache.delete(slug)
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

export const registry = new ProviderRegistry(new ProviderRepository())
