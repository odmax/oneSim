import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

export interface ApiAuthResult {
  authenticated: boolean
  businessId?: string
  businessName?: string
  apiKeyId?: string
  scopes?: string[]
  error?: string
  status?: number
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `onesim_${crypto.randomBytes(32).toString('hex')}`
  const prefix = raw.substring(0, 12)
  const hash = hashApiKey(raw)
  return { raw, prefix, hash }
}

export { hashApiKey, generateApiKey }

export async function authenticateApiKey(request: Request): Promise<ApiAuthResult> {
  const authHeader = request.headers.get('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      error: 'Missing or invalid Authorization header. Use: Authorization: Bearer ONESIM_CLIENT_API_KEY',
      status: 401,
    }
  }

  const apiKey = authHeader.slice(7).trim()

  if (!apiKey) {
    return {
      authenticated: false,
      error: 'API key is empty',
      status: 401,
    }
  }

  const keyHash = hashApiKey(apiKey)

  const keyRecord = await prisma.businessApiKey.findFirst({
    where: {
      keyHash,
      status: 'ACTIVE',
    },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          status: true,
        },
      },
    },
  })

  if (!keyRecord) {
    return {
      authenticated: false,
      error: 'Invalid or revoked API key',
      status: 401,
    }
  }

  if (keyRecord.business.status !== 'APPROVED') {
    return {
      authenticated: false,
      error: 'Business account is not approved',
      status: 403,
    }
  }

  if (keyRecord.expiresAt && new Date() > keyRecord.expiresAt) {
    return { authenticated: false, error: 'API key has expired', status: 401 }
  }

  // Update last used timestamp (fire-and-forget)
  prisma.businessApiKey.update({
    where: { id: keyRecord.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {})

  return {
    authenticated: true,
    businessId: keyRecord.business.id,
    businessName: keyRecord.business.name,
    apiKeyId: keyRecord.id,
    scopes: keyRecord.scopes || [],
  }
}
