'use client'

interface MappingResult {
  key: string
  label: string
  found: boolean
  source?: string
}

export function MappingValidator({ endpointMappings, requestMappings, responseMappings, purchaseWorkflow }: {
  endpointMappings?: Record<string, string> | null
  requestMappings?: Record<string, any> | null
  responseMappings?: Record<string, any> | null
  purchaseWorkflow?: string
}) {
  const ep = endpointMappings || {}
  const rq = requestMappings || {}
  const rs = responseMappings || {}
  const workflow = purchaseWorkflow || 'SINGLE_STEP'
  const isTwoStep = workflow === 'TWO_STEP_RESERVATION_FULFILLMENT'

  const purchaseAliases = ['PURCHASE_ESIM', 'PURCHASE_INITIATE', 'CREATE_PACKAGE', 'ORDER_ESIM', 'PURCHASE_FULFILL']
  const purchaseEndpoint = purchaseAliases.find(a => ep[a])
  const hasInitiate = !!ep.INITIATE_PURCHASE
  const hasFulfill = !!ep.FULFILL_PURCHASE
  const hasCancel = !!ep.CANCEL_PURCHASE
  const hasStatusEndpoint = !!ep.GET_ORDER_DETAILS || !!ep.GET_ORDER_DETAIL || !!ep.GET_ESIM_STATUS

  const checks: MappingResult[] = []

  if (isTwoStep) {
    checks.push(
      { key: 'initiate_endpoint', label: 'INITIATE_PURCHASE endpoint', found: hasInitiate, source: hasInitiate ? 'endpointMappings.INITIATE_PURCHASE' : undefined },
      { key: 'fulfill_endpoint', label: 'FULFILL_PURCHASE endpoint', found: hasFulfill, source: hasFulfill ? 'endpointMappings.FULFILL_PURCHASE' : undefined },
      { key: 'cancel_endpoint', label: 'CANCEL_PURCHASE endpoint', found: hasCancel, source: hasCancel ? 'endpointMappings.CANCEL_PURCHASE' : 'optional but recommended' },
      { key: 'request_package_id', label: 'Request: packageTemplateId', found: !!rq.INITIATE_PURCHASE || !!rq.packageTemplateId, source: rq.INITIATE_PURCHASE ? 'requestMappings.INITIATE_PURCHASE' : undefined },
      { key: 'response_reservation_id', label: 'Response: reservationId path', found: !!(rs.reservationIdPath), source: rs.reservationIdPath ? 'responseMappings.reservationIdPath' : undefined },
      { key: 'response_iccid', label: 'Response: ICCID path', found: !!(rs.iccidPath || rs.iccidsPath), source: rs.iccidPath ? 'responseMappings.iccidPath' : rs.iccidsPath ? 'responseMappings.iccidsPath' : undefined },
      { key: 'response_activation_code', label: 'Response: Activation Code path', found: !!(rs.activationCodePath), source: rs.activationCodePath ? 'responseMappings.activationCodePath' : undefined },
      { key: 'response_provider_order_id', label: 'Response: Provider Order ID path', found: !!(rs.providerOrderIdPath || rs.packageIdPath), source: rs.providerOrderIdPath ? 'responseMappings.providerOrderIdPath' : rs.packageIdPath ? 'responseMappings.packageIdPath' : undefined },
    )
  } else {
    checks.push(
      { key: 'purchase_endpoint', label: 'Purchase Endpoint (PURCHASE_ESIM)', found: !!purchaseEndpoint, source: purchaseEndpoint ? 'endpointMappings.' + purchaseEndpoint : undefined },
      { key: 'status_endpoint', label: 'Status Endpoint (GET_ORDER_DETAILS)', found: hasStatusEndpoint, source: hasStatusEndpoint ? 'endpointMappings' : undefined },
      { key: 'request_plan_id', label: 'Request: planId / template_id', found: !!rq.PURCHASE_ESIM || !!rq.planId || !!rq.template_id, source: rq.PURCHASE_ESIM ? 'requestMappings.PURCHASE_ESIM' : undefined },
      { key: 'response_iccid', label: 'Response: ICCID path', found: !!(rs.iccidPath || rs.iccidsPath || rs.iccids), source: rs.iccidPath ? 'responseMappings.iccidPath' : rs.iccidsPath ? 'responseMappings.iccidsPath' : undefined },
      { key: 'response_activation_code', label: 'Response: Activation Code path', found: !!(rs.activationCodePath || rs.activationCodesPath), source: rs.activationCodePath ? 'responseMappings.activationCodePath' : rs.activationCodesPath ? 'responseMappings.activationCodesPath' : undefined },
      { key: 'response_provider_order_id', label: 'Response: Provider Order ID path', found: !!(rs.providerOrderIdPath || rs.activationIdPath), source: rs.providerOrderIdPath ? 'responseMappings.providerOrderIdPath' : rs.activationIdPath ? 'responseMappings.activationIdPath' : undefined },
    )
  }

  checks.push({ key: 'request_quantity', label: 'Request: quantity field', found: true, source: 'default (always sent)' })

  const missing = checks.filter(c => !c.found)
  const found = checks.filter(c => c.found)

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-gray-900">Purchase Mapping Validator</h4>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
            isTwoStep ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
          }`}>
            {isTwoStep ? 'Two-step reservation + fulfillment' : 'Single-step purchase'}
          </span>
        </div>
        {missing.length === 0 ? (
          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Ready</span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">{missing.length} missing</span>
        )}
      </div>

      {missing.length > 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-medium mb-1">Missing mappings will cause purchase failures:</p>
          <ul className="list-disc ml-4 space-y-0.5">
            {missing.map(c => <li key={c.key}>{c.label}</li>)}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        {checks.map(c => (
          <div key={c.key} className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-gray-50">
            <div className="flex items-center gap-2">
              {c.found ? (
                <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              )}
              <span className="text-gray-700">{c.label}</span>
            </div>
            {c.source && <span className="text-gray-400 font-mono">{c.source}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
