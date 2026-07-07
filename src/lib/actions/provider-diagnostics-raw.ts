'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'

export async function rawGetPlansTest(providerId: string, bodyJson: string): Promise<{
  success: boolean
  status?: number
  requestBody?: string
  responseBody?: any
  responseKeys?: string[]
  error?: string
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  let body: any
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return { success: false, error: 'Invalid JSON body' }
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: {
      id: true, name: true, code: true, apiBaseUrl: true,
      apiToken: true, tokenPlacement: true,
      endpointMappings: true, planListPath: true,
    },
  })

  if (!provider) return { success: false, error: 'Provider not found' }

  const baseUrl = provider.apiBaseUrl || ''
  if (!baseUrl) return { success: false, error: 'No API Base URL configured' }

  // Resolve GET_PLANS endpoint path
  const ep = (provider.endpointMappings || {}) as Record<string, string>
  const planEp = ep.GET_PLANS || ''
  let path = '/plans'
  if (planEp) {
    const parts = planEp.split(' ')
    path = parts.length > 1 ? parts[1] : parts[0]
  } else if (provider.planListPath) {
    path = provider.planListPath
  }

  const url = `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
  const token = decryptToken(provider.apiToken) || ''

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    console.log(`[rawGetPlansTest] POST ${url}`)
    console.log(`[rawGetPlansTest] Body: ${bodyJson.substring(0, 200)}`)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const responseText = await response.text()
    let responseData: any
    try {
      responseData = JSON.parse(responseText)
    } catch {
      responseData = { raw: responseText }
    }

    const responseKeys = responseData && typeof responseData === 'object' && !Array.isArray(responseData)
      ? Object.keys(responseData)
      : []

    console.log(`[rawGetPlansTest] Status: ${response.status} Keys: ${responseKeys.join(',')}`)

    return {
      success: true,
      status: response.status,
      requestBody: bodyJson,
      responseBody: responseData,
      responseKeys,
    }
  } catch (e: any) {
    console.error(`[rawGetPlansTest] Error:`, e.message)
    return { success: false, error: e.message || 'Request failed' }
  }
}
