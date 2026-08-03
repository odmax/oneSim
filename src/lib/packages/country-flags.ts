/**
 * ISO-3166-1 alpha-2 → emoji flag + display name.
 * Used for country autocomplete rendering in the Buy eSIM flow.
 */
const FLAG_DATA: Record<string, { flag: string; name: string; aliases: string[] }> = {
  ZA: { flag: '\uD83C\uDDFF\uD83C\uDDE6', name: 'South Africa', aliases: ['zaf'] },
  NG: { flag: '\uD83C\uDDF3\uD83C\uDDEC', name: 'Nigeria', aliases: [] },
  KE: { flag: '\uD83C\uDDF0\uD83C\uDDEA', name: 'Kenya', aliases: [] },
  GH: { flag: '\uD83C\uDDEC\uD83C\uDDED', name: 'Ghana', aliases: [] },
  TZ: { flag: '\uD83C\uDDF9\uD83C\uDDFF', name: 'Tanzania', aliases: [] },
  UG: { flag: '\uD83C\uDDFA\uD83C\uDDEC', name: 'Uganda', aliases: [] },
  EG: { flag: '\uD83C\uDDEA\uD83C\uDDEC', name: 'Egypt', aliases: [] },
  MA: { flag: '\uD83C\uDDF2\uD83C\uDDE6', name: 'Morocco', aliases: [] },
  ET: { flag: '\uD83C\uDDEA\uD83C\uDDF9', name: 'Ethiopia', aliases: [] },
  RW: { flag: '\uD83C\uDDF7\uD83C\uDDFC', name: 'Rwanda', aliases: [] },
  CI: { flag: '\uD83C\uDDE8\uD83C\uDDEE', name: "C\u00F4te d'Ivoire", aliases: ['ivory coast', 'côte', 'cote'] },
  SN: { flag: '\uD83C\uDDF8\uD83C\uDDF3', name: 'Senegal', aliases: [] },
  CM: { flag: '\uD83C\uDDE8\uD83C\uDDF2', name: 'Cameroon', aliases: [] },
  ZM: { flag: '\uD83C\uDDFF\uD83C\uDDF2', name: 'Zambia', aliases: [] },
  MW: { flag: '\uD83C\uDDF2\uD83C\uDDFC', name: 'Malawi', aliases: [] },
  BW: { flag: '\uD83C\uDDE7\uD83C\uDDFC', name: 'Botswana', aliases: [] },
  NA: { flag: '\uD83C\uDDF3\uD83C\uDDE6', name: 'Namibia', aliases: [] },
  MZ: { flag: '\uD83C\uDDF2\uD83C\uDDFF', name: 'Mozambique', aliases: [] },
  AO: { flag: '\uD83C\uDDE6\uD83C\uDDF4', name: 'Angola', aliases: [] },
  SD: { flag: '\uD83C\uDDF8\uD83C\uDDE9', name: 'Sudan', aliases: [] },
  TN: { flag: '\uD83C\uDDF9\uD83C\uDDF3', name: 'Tunisia', aliases: [] },
  US: { flag: '\uD83C\uDDFA\uD83C\uDDF8', name: 'United States', aliases: ['usa', 'america'] },
  GB: { flag: '\uD83C\uDDEC\uD83C\uDDE7', name: 'United Kingdom', aliases: ['uk', 'britain', 'england'] },
  DE: { flag: '\uD83C\uDDE9\uD83C\uDDEA', name: 'Germany', aliases: [] },
  FR: { flag: '\uD83C\uDDEB\uD83C\uDDF7', name: 'France', aliases: [] },
  IT: { flag: '\uD83C\uDDEE\uD83C\uDDF9', name: 'Italy', aliases: [] },
  ES: { flag: '\uD83C\uDDEA\uD83C\uDDF8', name: 'Spain', aliases: [] },
  JP: { flag: '\uD83C\uDDEF\uD83C\uDDF5', name: 'Japan', aliases: [] },
  KR: { flag: '\uD83C\uDDF0\uD83C\uDDF7', name: 'South Korea', aliases: ['korea'] },
  CN: { flag: '\uD83C\uDDE8\uD83C\uDDF3', name: 'China', aliases: [] },
  IN: { flag: '\uD83C\uDDEE\uD83C\uDDF3', name: 'India', aliases: [] },
  AE: { flag: '\uD83C\uDDE6\uD83C\uDDEA', name: 'United Arab Emirates', aliases: ['uae', 'dubai', 'emirates'] },
  SA: { flag: '\uD83C\uDDF8\uD83C\uDDE6', name: 'Saudi Arabia', aliases: ['saudi'] },
  TR: { flag: '\uD83C\uDDF9\uD83C\uDDF7', name: 'Turkey', aliases: ['türkiye'] },
  AU: { flag: '\uD83C\uDDE6\uD83C\uDDFA', name: 'Australia', aliases: [] },
  CA: { flag: '\uD83C\uDDE8\uD83C\uDDE6', name: 'Canada', aliases: [] },
  BR: { flag: '\uD83C\uDDE7\uD83C\uDDF7', name: 'Brazil', aliases: [] },
  MX: { flag: '\uD83C\uDDF2\uD83C\uDDFD', name: 'Mexico', aliases: [] },
  AR: { flag: '\uD83C\uDDE6\uD83C\uDDF7', name: 'Argentina', aliases: [] },
  ID: { flag: '\uD83C\uDDEE\uD83C\uDDE9', name: 'Indonesia', aliases: [] },
  TH: { flag: '\uD83C\uDDF9\uD83C\uDDED', name: 'Thailand', aliases: [] },
  PH: { flag: '\uD83C\uDDF5\uD83C\uDDED', name: 'Philippines', aliases: [] },
  VN: { flag: '\uD83C\uDDFB\uD83C\uDDF3', name: 'Vietnam', aliases: [] },
  MY: { flag: '\uD83C\uDDF2\uD83C\uDDFE', name: 'Malaysia', aliases: [] },
  SG: { flag: '\uD83C\uDDF8\uD83C\uDDEC', name: 'Singapore', aliases: [] },
  PT: { flag: '\uD83C\uDDF5\uD83C\uDDF9', name: 'Portugal', aliases: [] },
  NL: { flag: '\uD83C\uDDF3\uD83C\uDDF1', name: 'Netherlands', aliases: [] },
  BE: { flag: '\uD83C\uDDE7\uD83C\uDDEA', name: 'Belgium', aliases: [] },
  CH: { flag: '\uD83C\uDDE8\uD83C\uDDED', name: 'Switzerland', aliases: [] },
  AT: { flag: '\uD83C\uDDE6\uD83C\uDDF9', name: 'Austria', aliases: [] },
  PL: { flag: '\uD83C\uDDF5\uD83C\uDDF1', name: 'Poland', aliases: [] },
  SE: { flag: '\uD83C\uDDF8\uD83C\uDDEA', name: 'Sweden', aliases: [] },
  NO: { flag: '\uD83C\uDDF3\uD83C\uDDF4', name: 'Norway', aliases: [] },
  DK: { flag: '\uD83C\uDDE9\uD83C\uDDF0', name: 'Denmark', aliases: [] },
  FI: { flag: '\uD83C\uDDEB\uD83C\uDDEE', name: 'Finland', aliases: [] },
  IE: { flag: '\uD83C\uDDEE\uD83C\uDDEA', name: 'Ireland', aliases: [] },
  GR: { flag: '\uD83C\uDDEC\uD83C\uDDF7', name: 'Greece', aliases: [] },
  CZ: { flag: '\uD83C\uDDE8\uD83C\uDDFF', name: 'Czech Republic', aliases: ['czech'] },
  SS: { flag: '\uD83C\uDDF8\uD83C\uDDF8', name: 'South Sudan', aliases: [] },
}

export interface CountryFlagEntry {
  code: string
  flag: string
  name: string
  searchable: string
}

function getFlagEntry(code: string): CountryFlagEntry | null {
  const upper = code.toUpperCase()
  const data = FLAG_DATA[upper]
  if (!data) return null
  const aliases = data.aliases.join(' ')
  return {
    code: upper,
    flag: data.flag,
    name: data.name,
    searchable: `${upper.toLowerCase()} ${data.name.toLowerCase()} ${aliases}`.trim(),
  }
}

/**
 * Resolve an ISO country code to its flag emoji + name entry.
 * Returns null for unknown codes.
 */
export function countryFlagEntry(code: string | null | undefined): CountryFlagEntry | null {
  if (!code) return null
  return getFlagEntry(code)
}

/**
 * Try to match a search string to a country. Returns the country code if matched.
 * Matches against: ISO code, country name, and known aliases.
 * Uses word-level matching for queries ≤ 3 chars to avoid false positives.
 */
export function matchCountrySearch(query: string): string | null {
  const q = query.toLowerCase().trim()
  if (!q) return null
  for (const code of Object.keys(FLAG_DATA)) {
    const entry = FLAG_DATA[code]
    if (q.length <= 3) {
      // Short query — match against individual tokens only
      const tokens = [code.toLowerCase(), entry.name.toLowerCase(), ...entry.aliases]
      if (tokens.some(t => t === q || t.startsWith(q) || t.includes(` ${q}`) || t.includes(`${q} `))) return code
    } else {
      const searchable = `${code.toLowerCase()} ${entry.name.toLowerCase()} ${entry.aliases.join(' ')}`
      if (searchable.includes(q)) return code
    }
  }
  return null
}
