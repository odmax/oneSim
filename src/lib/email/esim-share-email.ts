import { getAppUrl } from '@/lib/config/urls'

export interface ESIMInstallEmailParams {
  recipientName: string
  packageName: string
  iccid: string
  activationCode?: string
  qrCodeUrl?: string
  installLink: string
  validityDays: number
}

export function buildESIMInstallEmail(params: ESIMInstallEmailParams): { subject: string; html: string } {
  const { recipientName, packageName, iccid, activationCode, qrCodeUrl, installLink, validityDays } = params
  const appUrl = getAppUrl()

  return {
    subject: `Your eSIM from OneSim Africa is ready to install — ${packageName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h2 style="color:#059669">OneSim Africa</h2>
        <p>Hi ${recipientName},</p>
        <p>Your eSIM package <strong>${packageName}</strong> is ready to install on your device.</p>

        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">Package</td><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;font-weight:600">${packageName}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">ICCID</td><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;font-family:monospace">${iccid}</td></tr>
          ${activationCode ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">Activation Code</td><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;font-family:monospace;font-weight:600">${activationCode}</td></tr>` : ''}
          <tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">Validity</td><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${validityDays} days</td></tr>
        </table>

        ${qrCodeUrl ? `
        <p style="font-size:13px;color:#374151;font-weight:600">Scan QR Code to Install:</p>
        <div style="text-align:center;margin:16px 0">
          <img src="${qrCodeUrl}" alt="eSIM QR Code" style="width:200px;height:200px;border:2px solid #e5e7eb;border-radius:8px" />
        </div>
        ` : ''}

        <p style="font-size:13px;color:#374151;font-weight:600">Install Instructions:</p>
        <ol style="font-size:13px;color:#374151;line-height:1.6">
          <li>Go to <strong>Settings → Cellular → Add eSIM</strong> on your iPhone or <strong>Settings → Network → Mobile Network → Add Carrier</strong> on Android</li>
          <li>Scan the QR code above or enter the activation code manually</li>
          <li>Follow the on-screen prompts to complete installation</li>
        </ol>

        <p style="font-size:13px;color:#374151">If you need help, visit: <a href="${installLink}" style="color:#059669">${installLink}</a></p>

        <p style="font-size:12px;color:#6b7280;margin-top:24px">— OneSim Africa (${appUrl})</p>
      </div>`,
  }
}