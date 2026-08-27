export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateApiKey } from '@/lib/api/auth'
import { logApiRequest, checkRateLimit, addRateLimitHeaders, createRateLimitResponse } from '@/lib/api/logging'
import { sendEmail } from '@/lib/email/send-email'
import { buildESIMInstallEmail } from '@/lib/email/esim-share-email'
import { getAppUrl } from '@/lib/config/urls'
import crypto from 'crypto'

function makeError(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function respond(request: NextRequest, body: any, status: number, startTime: number, businessId: string, options?: { apiKeyId?: string; errorMessage?: string; rateLimit?: { limit: number; remaining: number } }) {
  let response = NextResponse.json(body, { status })
  if (options?.rateLimit) response = addRateLimitHeaders(response, options?.rateLimit)
  await logApiRequest(request, response, startTime, businessId, { ...options, errorMessage: options?.errorMessage || (body?.error?.message || undefined) })
  return response
}

export async function POST(request: NextRequest, { params }: { params: { esimId: string } }) {
  const startTime = Date.now()
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) {
      return respond(request, makeError('AUTH_FAILED', auth.error || 'Authentication failed'), auth.status || 401, startTime, 'unknown', { errorMessage: auth.error })
    }

    const businessId = auth.businessId!
    const apiKeyId = auth.apiKeyId

    const rateCheck = await checkRateLimit(businessId)
    const rateLimit = { limit: rateCheck.limit, remaining: rateCheck.remaining }
    if (!rateCheck.allowed) return addRateLimitHeaders(createRateLimitResponse(), rateCheck)

    const esim = await prisma.eSIM.findUnique({
      where: { id: params.esimId },
      include: {
        purchase: { select: { businessId: true, package: true } },
      },
    })
    if (!esim) return respond(request, makeError('ESIM_NOT_FOUND', 'eSIM not found'), 404, startTime, businessId, { errorMessage: 'eSIM not found', rateLimit })
    if (esim.purchase.businessId !== businessId) return respond(request, makeError('FORBIDDEN', 'eSIM does not belong to this business'), 403, startTime, businessId, { errorMessage: 'Forbidden', rateLimit })

    let body: any
    try { body = await request.json() } catch { body = {} }

    const { email } = body

    // Generate a share token
    const token = crypto.randomBytes(32).toString('hex')
    await prisma.eSIMShareToken.create({
      data: {
        esimId: params.esimId,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    const installLink = `${getAppUrl()}/install/${token}`
    const pkg = (esim.purchase as any).package

    // Send email if recipient provided
    if (email) {
      const emailContent = buildESIMInstallEmail({
        recipientName: email.split('@')[0] || 'Customer',
        packageName: pkg.displayName || pkg.name,
        iccid: esim.iccid,
        activationCode: esim.activationCode || undefined,
        qrCodeUrl: esim.qrCodeUrl || undefined,
        installLink,
        validityDays: pkg.validityDays,
      })

      const emailResult = await sendEmail({ to: email, subject: emailContent.subject, html: emailContent.html })
      if (!emailResult.success) return respond(request, makeError('EMAIL_FAILED', 'Failed to send share email'), 500, startTime, businessId, { errorMessage: 'Email failed', rateLimit })

      await prisma.eSIM.update({
        where: { id: params.esimId },
        data: { sharedAt: new Date(), sharedToEmail: email },
      })
    }

    await prisma.auditLog.create({
      data: {
        action: 'API_SHARE_ESIM',
        entity: 'ESIM',
        entityId: params.esimId,
        details: `Shared eSIM via API${email ? ` to ${email}` : ''}`,
      },
    })

    return respond(request, {
      success: true,
      shareToken: token,
      installLink,
      sharedToEmail: email || null,
    }, 200, startTime, businessId, { apiKeyId, rateLimit })
  } catch (error: any) {
    console.error('API share error:', error)
    return NextResponse.json(makeError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
  }
}