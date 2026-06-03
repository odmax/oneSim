import { getAppUrl } from '@/lib/config/urls'

export interface SendEmailParams {
  to: string
  subject: string
  text?: string
  html: string
}

export async function sendEmail(params: SendEmailParams): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY

  if (apiKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'OneSim <noreply@onetelecom.cloud>', to: params.to, subject: params.subject, html: params.html }),
      })
      if (!res.ok) {
        const err = await res.text()
        console.error('Resend error:', err)
        return { success: false, error: 'Email send failed' }
      }
      return { success: true }
    } catch (e: any) {
      console.error('Resend exception:', e)
      return { success: false, error: e.message }
    }
  }

  // Dev fallback: log to console
  console.log(`\n========== EMAIL ==========`)
  console.log(`To: ${params.to}`)
  console.log(`Subject: ${params.subject}`)
  console.log(`Body: ${params.html.replace(/<[^>]*>/g, '')}`)
  console.log(`===========================\n`)
  return { success: true }
}

export function buildResetPasswordEmail(link: string): { subject: string; html: string } {
  const appUrl = getAppUrl()
  return {
    subject: 'Reset your OneSim password',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#059669">OneSim Africa</h2>
        <p>Click the button below to reset your password.</p>
        <a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Reset Password</a>
        <p style="font-size:12px;color:#6b7280">This link expires in 1 hour. If you did not request this, please ignore this email.</p>
        <p style="font-size:12px;color:#6b7280">— OneSim Africa (${appUrl})</p>
      </div>`,
  }
}
