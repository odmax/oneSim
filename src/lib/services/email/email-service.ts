import { prisma } from '@/lib/prisma'

export interface EmailPayload {
  to: string
  subject: string
  html: string
  text?: string
  template?: string
  templateData?: Record<string, any>
}

const NOTIFICATION_EMAILS: Record<string, { subject: string; template: string }> = {
  qr_ready: { subject: 'Your eSIM is Ready — Scan to Install', template: 'qr-ready' },
  order_failed: { subject: 'Order Failed — Action Required', template: 'order-failed' },
  topup_completed: { subject: 'Top-Up Completed Successfully', template: 'topup-completed' },
  refund_completed: { subject: 'Refund Processed', template: 'refund-completed' },
  wallet_low: { subject: 'Low Wallet Balance — Please Top Up', template: 'wallet-low' },
  invoice_generated: { subject: 'New Invoice from OneSIM Africa', template: 'invoice-generated' },
}

function renderTemplate(templateName: string, data: Record<string, any>): string {
  const templates: Record<string, (d: Record<string, any>) => string> = {
    'qr-ready': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#059669">Your eSIM is Ready!</h2>
<p>Hi ${d.customerName || 'there'},</p>
<p>Your eSIM for <strong>${d.packageName || 'your plan'}</strong> is ready to install.</p>
${d.qrCodeUrl ? `<p>Scan this QR code to install:</p><p><img src="${d.qrCodeUrl}" style="width:200px;height:200px;border:1px solid #ddd;border-radius:8px" /></p>` : ''}
${d.activationCode ? `<p>Or enter this activation code manually: <code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;font-size:14px">${d.activationCode}</code></p>` : ''}
<p style="color:#6b7280;font-size:12px">Open Settings → Cellular → Add eSIM to install.</p>
<p style="color:#6b7280;font-size:12px">ICCID: ${d.iccid || ''}</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa — ${d.businessName || ''}</p>
</div>`,

    'order-failed': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#dc2626">Order Failed</h2>
<p>Your order for <strong>${d.packageName || 'your package'}</strong> could not be completed.</p>
<p style="color:#6b7280">Error: ${d.error || 'Unknown error'}</p>
<p>No amount has been deducted from your wallet.</p>
<p>Please try again or <a href="${d.supportUrl || '#'}" style="color:#0891b2">contact support</a>.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa</p>
</div>`,

    'topup-completed': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#059669">Top-Up Completed</h2>
<p>Your eSIM <strong>${d.iccid ? d.iccid.slice(-8) : ''}</strong> has been topped up successfully.</p>
${d.dataAddedMB ? `<p>Data added: <strong>${(d.dataAddedMB / 1024).toFixed(2)} GB</strong></p>` : ''}
${d.validityDaysAdded ? `<p>Validity extended by: <strong>${d.validityDaysAdded} days</strong></p>` : ''}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa</p>
</div>`,

    'refund-completed': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#059669">Refund Processed</h2>
<p>A refund of <strong>$${d.amount || '0'}</strong> has been processed to your wallet.</p>
${d.reason ? `<p style="color:#6b7280">Reason: ${d.reason}</p>` : ''}
<p>Your updated wallet balance is <strong>$${d.balance || '0'}</strong>.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa</p>
</div>`,

    'wallet-low': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#d97706">Low Wallet Balance</h2>
<p>Your wallet balance is <strong>$${d.balance || '0'}</strong>.</p>
<p>This may be too low for your next purchase. Please <a href="${d.topUpUrl || '#'}" style="color:#0891b2">top up your wallet</a> to continue using the service without interruption.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa</p>
</div>`,

    'invoice-generated': (d) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px">
<h2 style="color:#059669">New Invoice</h2>
<p>Invoice <strong>#${d.invoiceNumber || d.invoiceId?.slice(-8) || ''}</strong> has been generated.</p>
<p>Amount: <strong>$${d.amount || '0'}</strong></p>
${d.dueDate ? `<p>Due: ${new Date(d.dueDate).toLocaleDateString()}</p>` : ''}
<p style="color:#6b7280;font-size:12px">This invoice will be marked as paid automatically from your wallet balance.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
<p style="color:#9ca3af;font-size:11px">OneSIM Africa</p>
</div>`,
  }

  const render = templates[templateName]
  if (!render) return `<p>Notification: ${templateName}</p>`
  return render(data)
}

export async function sendEmail(payload: EmailPayload): Promise<{ success: boolean; error?: string }> {
  const from = process.env.EMAIL_FROM || 'noreply@onetelecom.cloud'

  // Use configured email service or log to console
  const emailService = process.env.EMAIL_SERVICE || 'log'

  try {
    if (emailService === 'sendgrid') {
      // SendGrid integration point
      console.log(`[EMAIL] SendGrid would send to ${payload.to}: ${payload.subject}`)
      return { success: true }
    }

    if (emailService === 'smtp') {
      // SMTP integration point
      console.log(`[EMAIL] SMTP would send to ${payload.to}: ${payload.subject}`)
      return { success: true }
    }

    // Default: log to console
    console.log(`[EMAIL] From: ${from} To: ${payload.to} Subject: ${payload.subject}`)

    // Store in audit log for tracking
    await prisma.auditLog.create({
      data: {
        action: 'EMAIL_SENT',
        entity: 'EmailDelivery',
        entityId: payload.template || null,
        details: JSON.stringify({ to: payload.to, subject: payload.subject, template: payload.template }),
      },
    }).catch(() => {})

    return { success: true }
  } catch (e: any) {
    console.error(`[EMAIL] Failed to send to ${payload.to}:`, e.message)
    return { success: false, error: e.message }
  }
}

export async function sendNotificationEmail(type: string, recipientEmail: string, data: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  const config = NOTIFICATION_EMAILS[type]
  if (!config) return { success: false, error: `Unknown email type: ${type}` }

  const html = renderTemplate(config.template, data)

  return await sendEmail({
    to: recipientEmail,
    subject: config.subject,
    html,
    template: config.template,
    templateData: data,
  })
}
