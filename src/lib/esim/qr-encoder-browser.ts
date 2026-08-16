/**
 * Browser-safe QR rendering entry point.
 *
 * Uses the mature `qrcode` library's `toDataURL` (browser-safe, no Node Buffer
 * dependency) to render an installation payload into a QR image data URL.
 * Never uploads QR data to an external service.
 */
import QRCode from 'qrcode'

/** Render a payload to a PNG data URL sized `sizePx` (default 192). */
export async function renderQrPayloadSvg(payload: string, _scale = 8, sizePx = 192): Promise<string> {
  // `qrcode` toDataURL returns a PNG data URL. We name the wrapper
  // `renderQrPayloadSvg` for call-site compatibility but render a PNG which is
  // universally displayable in <img>.
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width: sizePx, margin: 4 })
}
