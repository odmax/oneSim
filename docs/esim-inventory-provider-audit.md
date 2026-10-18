# eSIM Inventory provider audit — 2026-09-28

Base: 135db63eb99d4fdaf64b13780c5e8ab16f382b68 (staging revision 21).
This is a source audit, not live provider certification.

## Confirmed gaps and corrections

- Compact pending/READY badges inferred that installation was still required from available installation data. The shared summary now says Activation pending; this does not manufacture installation or activation evidence.
- US-Matrix getStatus recognized INSTALLED profile logs but omitted the same value on activationProfile.status. The direct profile value is now recognized as installed evidence, without network activation.
- Manual status refresh reported success when synchronization was skipped. Unsupported status lookup and missing provider references now produce explanatory feedback.
- Inventory offered Top Up based only on lifecycle status and always displayed Refresh Status. Actions now require implemented connector capabilities and portal exposure, resolved once per provider per request. Last successful status check is visible.
- Device installation set activatedAt and activationDetectedAt, allowing a later ambiguous ACTIVE response to inherit manufactured activation evidence. New installation evidence no longer sets those timestamps.
- Authoritative positive usage promoted pending rows but omitted INSTALLED rows. Installed rows now also promote from positive finite usage; zero, missing and invalid usage do not promote.

## Provider evidence from contracts and source

| Connector | Status polling | Usage polling | Installation/network evidence |
|---|---|---|---|
| AirHub | Order detail | Not implemented | isActive retained as diagnostics; no evidence emitted |
| US-Matrix | Profile and location events | Implemented | Installed/enabled profile; successful network event |
| Telna standard | SIM and profile reads | Implemented | SIM in-service; installed/enabled profile |
| Telna seamless | Subscription | Not implemented | No dedicated install/network evidence identified |
| Telna flex | Not implemented | Implemented | Usage activation path |
| URL-token | Implemented | Implemented | Usage activation path; declares webhooks false |
| iBASIS | Implemented | No polling | Declares webhook support; live delivery not checked |
| Standard/header-token | Configurable/generic | Configurable/generic | Requires response/contract verification |

Connector flags describe current integration implementation, not everything a provider may offer. Installation-data lookup is not device-installation detection.

### AirHub contract review

The uploaded AIRHUBAPP API PDF (20 pages) documents purchase, POST /api/ESIM/GetOrderDetail, wallet checks, activation-code retrieval, renewals, and plan/country lookups. It shows flag=1 for the last 300 orders and flag=2 with mandatory date bounds. The guide does not document a usage endpoint or a device-install/network-attach lookup. Its example GetOrderDetail response is clipped in the screenshot, and neither the PDF nor the accessible Swagger rendering defines the semantics of isActive. Therefore the connector must not map isActive to device installation or confirmed network attachment without an authoritative AirHub definition. It remains diagnostic.

The live Swagger URL supplied by the user, https://api.airhubapp.com/swagger/index.html, and the likely raw Swagger JSON paths were inaccessible through the available read-only documentation reader. The PDF was supplied as a July 2024 training module, so it cannot prove that the current API has no additional endpoints. Current AirHub usage/install capability remains unverified; in OneSIM code, usage lookup is not implemented and no install/network evidence is emitted.

### US-Matrix contract review

The published US-Matrix OpenAPI 3.0 page lists POST /api/v1/esims/info (Get detailed eSIM information from vendor), POST /api/v1/packages/usage, and POST /api/v1/esims/location-event-logs (Get live location event logs), along with raw event and raw location log reads. The connector implements the first, usage lookup, and location-event log path. It maps profile INSTALLED/ENABLED to installed evidence and a successful attach event to network-active evidence. The current fix also recognizes activationProfile.status=INSTALLED directly. The Swagger operation list contains no webhook operation. The installed connector advertises webhooks=false.

US-Matrix usage association is not a direct ICCID lookup in the usage endpoint: the connector first resolves the package-to-eSIM association through mobile-detail, then calls package usage and converts provider rate groups into MB. This implementation has provider fixture tests, but affected-ICCID staging evidence is still needed to verify that the usage association exists and the live response carries usable values.

## Required evidence before full certification

1. AirHub partner confirmation: exact meaning of GetOrderDetail.isActive; whether current API has device-install/network status, usage endpoints, and webhook subscription/delivery. Do not infer network activity from the field name or order completion. The supplied PDF and Swagger shell do not expose enough schema detail to answer this.
2. Current redacted US-Matrix /esims/info, location-event, mobile-detail, and package-usage responses for an affected ICCID. The Swagger page publishes the operation names and DTO inventory but its rendered schema details were unavailable in the reader.
3. Read-only staging record comparison per affected ICCID: canonical status, installationStatus, provider identifiers, activatedAt, activationDetectedAt, lastStatusSyncAt, lastUsageSyncAt, usage values, next-sync timestamps and retry counts; compare with redacted provider evidence.
4. Existing INSTALLED rows may carry activation timestamps created by the old installation rule. This change does not remove existing timestamps or repair already-ACTIVE rows. Audit provenance before any repair; old timestamps alone are not sufficient certification.
5. Custom/routed products: both sync services currently resolve provider from purchase.package.providerId. Verify that this is the actual fulfilling provider for each custom order before certifying those paths.
6. Verify provider-specific units, expiry, webhook setup, failures and action authorization across the remaining adapters. The focused fixes do not certify all connectors.

## Validation

- Initial connector/status/presentation/action selection: 6 files, 533 tests passed.
- Expanded lifecycle, sync, usage, jobs and presentation selection: 35 files, 938 tests passed.
- Full invocation: 238 suites passed; 3 DB integration suites failed initialization due to missing DATABASE_URL (4943 passed tests, 9 failed, 93 skipped). No database connection was configured or used.
- No live AWS, database or authenticated provider operations performed.
- This audit does not certify a deployment or repair live data; affected-provider evidence is still required.
