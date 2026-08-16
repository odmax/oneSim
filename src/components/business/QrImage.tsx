import { renderQrPayload } from '@/lib/esim/qr-encoder'

/**
 * Renders a QR code locally from an LPA/payload string into an SVG data URL.
 * Server-rendered; no provider call, no external QR service. Falls back to the
 * provider image URL when one is supplied.
 */
export function QrImage({ payload, imageUrl, alt, className }: { payload?: string | null; imageUrl?: string | null; alt?: string; className?: string }) {
  const src = imageUrl || (payload ? renderQrPayload(payload) : undefined)
  if (!src) return null
  return <img src={src} alt={alt || 'eSIM QR Code'} className={className} />
}
