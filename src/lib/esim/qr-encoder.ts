/**
 * QR rendering for OneSIM installation payloads.
 *
 * Delegates to the mature, standards-compliant `qrcode` library (MIT) rather
 * than maintaining a custom encoder. Renders locally — installation secrets are
 * never uploaded to an external QR service.
 *
 * Exposes a small provider-neutral surface used by UI and the QR-download route:
 *   - generateQrMatrix(payload)        → boolean[][] dark-module matrix
 *   - qrMatrixToSvgDataUrl(matrix)     → SVG data URL
 *   - renderQrPayload(payload)         → SVG data URL (main entry point)
 *   - qrMatrixToRgba(matrix)           → RGBA pixels (decoder tests)
 *   - qrSizeForText(payload)           → module count
 *
 * `qrcode` computes ECC automatically (default errorCorrectionLevel 'M') and
 * throws a controlled error when the payload exceeds the largest supported QR
 * version — the caller must degrade to manual-install presentation, never
 * render a corrupt QR.
 */
import QRCode from 'qrcode'

/** Generate a QR dark-module matrix for a text payload. */
export function generateQrMatrix(text: string): boolean[][] {
  const size = qrSizeForText(text)
  const matrix: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  // qrcode's create returns a BitMatrix with .size and .get(row, col).
  const created = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const bitMatrix = created.modules as unknown as { size: number; get(row: number, col: number): number }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      matrix[r][c] = bitMatrix.get(r, c) === 1
    }
  }
  return matrix
}

/** Render a QR matrix into an SVG data URL. */
export function qrMatrixToSvgDataUrl(matrix: boolean[][], scale = 8, color = '#000000', bg = '#ffffff'): string {
  const n = matrix.length
  const sizePx = n * scale
  let rects = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) rects += `<rect x="${c * scale}" y="${r * scale}" width="${scale}" height="${scale}"/>`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" shape-rendering="crispEdges"><rect width="${sizePx}" height="${sizePx}" fill="${bg}"/>${rects}</svg>`
  const b64 = Buffer.from(svg, 'utf8').toString('base64')
  return `data:image/svg+xml;base64,${b64}`
}

/** Render a payload to a QR SVG data URL (main entry point for UI/download). */
export function renderQrPayload(payload: string): string {
  const matrix = generateQrMatrix(payload)
  return qrMatrixToSvgDataUrl(matrix)
}

/**
 * Render a QR matrix into a raw RGBA pixel buffer (Uint8ClampedArray) with a
 * quiet zone. Used by the round-trip decoder test and any raster consumer.
 */
export function qrMatrixToRgba(matrix: boolean[][], scale = 8, quietZone = 4): Uint8ClampedArray {
  const n = matrix.length
  const dim = (n + quietZone * 2) * scale
  const px = new Uint8ClampedArray(dim * dim * 4)
  for (let i = 0; i < dim * dim; i++) {
    px[i * 4] = 255
    px[i * 4 + 1] = 255
    px[i * 4 + 2] = 255
    px[i * 4 + 3] = 255
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue
      const baseR = (r + quietZone) * scale
      const baseC = (c + quietZone) * scale
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((baseR + dy) * dim + (baseC + dx)) * 4
          px[idx] = 0
          px[idx + 1] = 0
          px[idx + 2] = 0
          px[idx + 3] = 255
        }
      }
    }
  }
  return px
}

/** Number of RGBA pixels on one side for a matrix + quiet zone. */
export function qrRgbaDimension(matrix: boolean[][], scale = 8, quietZone = 4): number {
  return (matrix.length + quietZone * 2) * scale
}

/** Number of modules on a side for a payload. */
export function qrSizeForText(text: string): number {
  // QRCode.create throws a controlled error when the payload is too large for
  // any version at the given ECC level. We mirror that surface here.
  const created = QRCode.create(text, { errorCorrectionLevel: 'M' })
  return (created.modules as unknown as { size: number }).size
}
