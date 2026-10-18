/**
 * Locale-safe decimal parsing for admin catalog forms.
 *
 * WHY THIS EXISTS
 * ---------------
 * Admin users enter prices in a comma-decimal locale (`21,49`) and in a
 * dot-decimal locale (`21.49`). Naive `parseFloat` on `"21,49"` returns `21`
 * — silently dropping the fractional part and corrupting the selling price
 * (the root cause of catalog prices reverting). `Number("21,49")` returns NaN.
 *
 * This module is the ONLY sanctioned way to convert free-form price markup
 * inputs into numbers. Contract:
 *   - empty/whitespace      → null (not a price edit)
 *   - `"21,49"` / `"21.49"` → 21.49
 *   - `"1.234,56"`          → 1234.56 (thousands separator)
 *   - `"1,234.56"`          → 1234.56 (thousands separator)
 *   - `21,49` NEVER becomes 2149, 21, 0, or NaN
 *   - garbage               → null
 *
 * Never returns NaN / Infinity. Never throws.
 */
export function parseDecimalInput(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null

  let s = raw.replace(/\s+/g, '').trim()
  if (s === '') return null

  const hasComma = s.includes(',')
  const hasDot = s.includes('.')

  if (hasComma && hasDot) {
    // A trailing dot means the dot is the decimal separator (e.g. "1,234.56");
    // a trailing comma means the comma is the separator (e.g. "1.234,56").
    // We only accept the dot-as-separator form; the reversed layout is
    // rejected explicitly rather than silently corrupted.
    if (s.lastIndexOf('.') < s.lastIndexOf(',')) return null
    // Collapse each comma-thousands group into its integer run: every segment
    // except the last is a thousands group (strip its dots), the last segment
    // keeps its decimal dot. Joining without a separator reconstructs the
    // canonical "1234.56".
    s = s
      .split(',')
      .map((seg, idx, arr) => (idx < arr.length - 1 ? seg.replace(/\./g, '') : seg))
      .join('')
  } else if (hasComma) {
    const parts = s.split(',')
    // "1,234" (thousands) has a short integer group and exactly 3 fraction
    // digits; "21,49" has exactly two fraction digits (a decimal comma).
    // Multi-comma groups are always thousands separators.
    if (parts.length > 2 || (parts[1] && parts[1].length === 3 && parts[0].length <= 3)) {
      // Treat as thousands separator — collapse commas.
      s = s.replace(/,/g, '')
    } else {
      s = s.replace(',', '.')
    }
  } else {
    // Dot-only input is already canonical.
    s = s
  }

  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}

/** Strictly positive money value (avoided by rounding to cents). */
export function isPositivePrice(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v > 0
}