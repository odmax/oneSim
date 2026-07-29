'use client'

import { useState } from 'react'

interface ParsedQuery {
  country: string | null
  region: string | null
  dataGB: number | null
  validityDays: number | null
  maxBudget: number | null
  cheapest: boolean
}

function parseQuery(text: string): ParsedQuery {
  const lower = text.toLowerCase()
  const result: ParsedQuery = { country: null, region: null, dataGB: null, validityDays: null, maxBudget: null, cheapest: false }

  if (/\bcheapest\b/i.test(text)) result.cheapest = true
  if (/\blowest\b/i.test(text)) result.cheapest = true

  const underBudget = text.match(/\bunder\s*\$?(\d+(?:\.\d{1,2})?)\b/i)
  if (underBudget) result.maxBudget = parseFloat(underBudget[1])

  const dataMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:GB|gb|Gb|gB)\b/)
  if (dataMatch) result.dataGB = parseFloat(dataMatch[1])

  // Cap common mis-parses: "1GB plan under $5" → dataGB=1, maxBudget=5
  const budgetAfterGig = text.match(/(\d+)\s*(?:GB|gb)\b.*?\$(\d+(?:\.\d{1,2})?)/i)
  if (budgetAfterGig) {
    result.dataGB = parseInt(budgetAfterGig[1])
    result.maxBudget = parseFloat(budgetAfterGig[2])
  }

  const daysMatch = text.match(/(\d+)\s*(?:days?|d)\b/i)
  if (daysMatch) result.validityDays = parseInt(daysMatch[1])

  const countryPatterns: Record<string, string[]> = {
    'ZA': ['south africa', 'sa'],
    'KE': ['kenya'],
    'NG': ['nigeria'],
    'GH': ['ghana'],
    'TZ': ['tanzania'],
    'UG': ['uganda'],
    'EG': ['egypt'],
    'MA': ['morocco'],
    'ET': ['ethiopia'],
    'RW': ['rwanda'],
    'CI': ["cote d'ivoire", 'ivory coast', 'côte'],
    'SN': ['senegal'],
    'CM': ['cameroon'],
    'ZM': ['zambia'],
    'MW': ['malawi'],
    'BW': ['botswana'],
    'NA': ['namibia'],
    'MZ': ['mozambique'],
    'AO': ['angola'],
    'SD': ['sudan'],
    'TN': ['tunisia'],
    'US': ['united states', 'usa', 'america'],
    'GB': ['united kingdom', 'uk', 'britain', 'england'],
    'DE': ['germany'],
    'FR': ['france'],
    'IT': ['italy'],
    'ES': ['spain'],
    'JP': ['japan'],
    'KR': ['south korea', 'korea'],
    'CN': ['china'],
    'IN': ['india'],
    'AE': ['uae', 'dubai', 'emirates'],
    'SA': ['saudi', 'saudi arabia'],
    'TR': ['turkey', 'türkiye'],
    'AU': ['australia'],
    'CA': ['canada'],
    'BR': ['brazil'],
    'MX': ['mexico'],
    'AR': ['argentina'],
    'ID': ['indonesia'],
    'TH': ['thailand'],
    'PH': ['philippines'],
    'VN': ['vietnam'],
    'MY': ['malaysia'],
    'SG': ['singapore'],
  }

  const regionPatterns: Record<string, string[]> = {
    'Europe': ['europe', 'euro', 'eu', 'european'],
    'Asia': ['asia', 'asian'],
    'Africa': ['africa', 'african'],
    'Americas': ['americas', 'america', 'americas'],
    'Middle East': ['middle east', 'middle-east'],
    'Global': ['global', 'worldwide', 'international', 'world'],
    'Regional': ['regional'],
  }

  for (const [code, patterns] of Object.entries(countryPatterns)) {
    if (patterns.some(p => lower.includes(p))) {
      result.country = code
      break
    }
  }

  if (!result.country) {
    for (const [region, patterns] of Object.entries(regionPatterns)) {
      if (patterns.some(p => lower.includes(p))) {
        result.region = region
        break
      }
    }
  }

  return result
}

interface Props {
  onSearch: (query: ParsedQuery) => void
  onClear: () => void
}

const SUGGESTIONS = [
  'I need 5GB for France for 7 days',
  'Show me the cheapest South Africa package',
  'Find a 1GB plan under $5',
  'I need a regional Europe plan',
  'Show Kenya packages',
]

export default function EsimSearchAssistant({ onSearch, onClear }: Props) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSearch = () => {
    if (!input.trim()) return
    executeSearch(input)
  }

  const executeSearch = (text: string) => {
    setLoading(true)
    setInput(text)
    const parsed = parseQuery(text)
    onSearch(parsed)
    setTimeout(() => setLoading(false), 300)
  }

  const handleClear = () => {
    setInput('')
    onClear()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  return (
    <div className="rounded-xl border bg-gradient-to-r from-cyan-50 to-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <h3 className="text-sm font-semibold text-gray-900">Find your eSIM</h3>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='e.g. "5GB for France for 7 days" or "cheapest South Africa"'
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
        />
        <button
          onClick={handleSearch}
          disabled={!input.trim() || loading}
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors"
        >
          {loading ? '...' : 'Search'}
        </button>
        {input && (
          <button onClick={handleClear} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">
            Clear
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="text-xs text-gray-400">Try:</span>
        {SUGGESTIONS.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => executeSearch(s)}
            className="rounded-full bg-white border border-gray-200 px-2.5 py-0.5 text-xs text-gray-500 hover:bg-cyan-50 hover:text-cyan-600 hover:border-cyan-200 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

export { parseQuery }
export type { ParsedQuery }
