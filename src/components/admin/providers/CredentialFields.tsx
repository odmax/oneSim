'use client'

export function CredentialFields({ authType, configurationFields, onChange, values = {}, extraFields = [] }: {
  type?: string; authType?: string | null; authUrl?: string | null
  configurationFields?: any[]; onChange?: (f: string, v: string) => void
  values?: Record<string, string>
  extraFields?: Array<{ name: string; label: string; type: string; required: boolean; placeholder?: string; options?: { value: string; label: string }[] }>
}) {
  // Use configurationFields if provided (template-driven)
  if (configurationFields && configurationFields.length > 0) {
    return renderDynamic(configurationFields, onChange, values)
  }

  // Fallback to authType-based fields + extraFields (legacy)
  const base = authType ? fieldsForAuth(authType) : []
  const names = new Set(base.map((f: any) => f.name))
  const merged = [...base, ...(extraFields || []).filter((f: any) => !names.has(f.name))]
  if (merged.length === 0) return <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">No configuration fields defined.</div>
  return renderLegacy(merged, onChange, values)
}

function fieldsForAuth(authType: string) {
  const common = [
    { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Username' },
    { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Password' },
  ]
  if (authType === 'credentials') return [...common, { name: 'environment', label: 'Environment', type: 'select', required: false, options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] }]
  if (authType === 'basic') return common
  if (authType === 'api_key') return [{ name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API key' }]
  if (authType === 'bearer_token') return [{ name: 'apiToken', label: 'API Token', type: 'password', required: true, placeholder: 'API token' }]
  return [
    { name: 'apiToken', label: 'API Token / Key', type: 'password', required: false, placeholder: 'API token or key' },
    { name: 'apiBaseUrl', label: 'API Base URL', type: 'text', required: false, placeholder: 'https://api.example.com' },
  ]
}

function renderDynamic(fields: any[], onChange?: any, values: Record<string, string> = {}) {
  const groups = ['credentials', 'environment', 'endpoints', 'config', 'testing']
  const grouped: Record<string, any[]> = {}
  for (const f of fields) {
    const g = f.group || 'config'
    if (!grouped[g]) grouped[g] = []
    grouped[g].push(f)
  }
  return (<div className="space-y-6">{groups.filter(g => grouped[g]).map(group => (
    <div key={group}><h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{group}</h4>
      <div className="space-y-4">{grouped[group].map((f: any) => {
        const id = `cfg-${f.key}`; const val = values[f.key] || f.default || ''
        return (<div key={f.key}>
          <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">{f.label}{f.required ? <span className="text-red-500 ml-0.5">*</span> : null}{f.secret ? <span className="text-xs text-gray-400 ml-1">(encrypted)</span> : null}</label>
          {f.type === 'select' && f.options ? (
            <select id={id} name={f.key} required={f.required} defaultValue={val} onChange={e => onChange?.(f.key, e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              {f.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'readonly' ? (
            <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600 font-mono">{f.default || f.placeholder || '—'}</div>
          ) : f.type === 'boolean' ? (
            <input id={id} name={f.key} type="checkbox" defaultChecked={val === 'true'} onChange={e => onChange?.(f.key, e.target.checked ? 'true' : 'false')} className="h-4 w-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
          ) : (
            <input id={id} name={f.key} type={f.secret ? 'password' : f.type === 'url' ? 'text' : f.type} required={f.required} placeholder={f.placeholder || ''} defaultValue={val} onChange={e => onChange?.(f.key, e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" autoComplete={f.secret ? 'new-password' : 'off'} />
          )}
        </div>)
      })}</div>
    </div>
  ))}</div>)
}

function renderLegacy(fields: any[], onChange?: any, values: Record<string, string> = {}) {
  return (<div className="space-y-4">{fields.map((f: any) => (
    <div key={f.name}>
      <label htmlFor={`cred-${f.name}`} className="block text-sm font-medium text-gray-700 mb-1">{f.label}{f.required ? <span className="text-red-500 ml-0.5">*</span> : null}</label>
      {f.type === 'select' && f.options ? (
        <select id={`cred-${f.name}`} name={f.name} required={f.required} defaultValue={values[f.name] || f.options[0]?.value || ''} onChange={e => onChange?.(f.name, e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
          {f.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={`cred-${f.name}`} name={f.name} type={f.type} required={f.required} placeholder={f.placeholder || ''} defaultValue={values[f.name] || ''} onChange={e => onChange?.(f.name, e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" autoComplete={f.type === 'password' ? 'new-password' : 'off'} />
      )}
    </div>
  ))}</div>)
}
