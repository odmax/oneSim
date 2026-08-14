# OneSim Pre-Deployment Integrity Audit

**Date:** August 14, 2026
**Baseline:** `82fe129` (QR/install fix + correction commit, already pushed)
**Working head:** baseline + 3 approved fixes (uncommitted)
**Audit scope:** purchase path, provider abstraction, wallet/order integrity, QR/install pipeline, secrets/leaks, dead code, routes, jobs, build/test integrity

---

## 25-Item Audit Matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Baseline integrity: worktree clean, `origin/main` == `82fe129` | ✅ | `git log -1`, `git status --short` empty at start |
| 2 | QR/install normalizer is the sole installation-mapping path | ✅ | `src/lib/esim/installation-data.ts` (`normalizeConnectorInstallData`, `extractInstallDataFromProviderResponse`, `mergeInstallData`, `hasUsableInstallData`) — single whitelist mapping |
| 3 | All persistence paths refactor onto the canonical normalizer | ✅ | `provider-attempt-service.ts:133`, `fulfillment.ts:74,127,143,173` all call it; no legacy ad-hoc mapping remains |
| 4 | No duplicate purchase path reachable | ✅ | All entry points (`/api/esim/purchase`, `/api/v1/esims/order`, `src/lib/actions/purchase.ts`) → single `createOrder` → `PurchaseOrchestrator.executePurchase` → `executeProviderAttempt` |
| 5 | Legacy `provider-purchase.ts` classified | ✅ | `initiateAndFulfillPurchase`/`cancelPurchase`/`topUpPurchase`/`getPurchaseUsage`: ZERO imports outside the file. Dead billable engine — unreachable, not wired into any route/page/action |
| 6 | No provider factory conflict | ✅ | `connector-factory.ts:43-88` single `createConnector` switch; one connector per type; legacy `ProviderRegistry` only a suppressed fallback in `adapter-manager.ts:220-228` |
| 7 | No direct `adapter.activateESIM` outside canonical path | ✅ | Non-test call sites: `provider-attempt-service.ts:89` (canonical), `recovery.ts:349` (guarded redispatch for stuck orders only), `adapter-manager.ts:47-48` (wrapper). No dual purchase/activation engine live |
| 8 | Client provider/secrets leak — **FIXED** | ✅ | `admin/providers/[id]/page.tsx:61-66` now filters sensitive config keys before shipping to client; `:249` renders redacted config |
| 9 | No sensitive config in server-rendered HTML | ✅ | Raw `JSON.stringify(provider.config)` replaced with `redactSensitiveConfig` (password/apiKey/apiToken/tokens/authAccounts/webhookAuth masked) |
| 10 | Wallet reserve→capture→release idempotent + guarded | ✅ | `wallet-actions.ts`: capture single-shot, release blocked on CAPTURE/REFUND/provider-evidence; `fulfillment.ts` P2002/ICCID-dedup persistence |
| 11 | Wallet TOCTOU race — **FIXED** | ✅ | `reserveWalletFunds` now uses a conditional atomic decrement (`updateMany where walletBalance >= amount`) inside one transaction — concurrent purchases can no longer overdraw |
| 12 | No same-order double reserve/capture; no over-release | ✅ | Idempotency check moved inside the reserve transaction; same-order reuse unreachable (order created once per purchase; idempotency-key path returns before reserving) |
| 13 | Choice (URL_TOKEN) endpoint contract verified | ✅ | Code+test level: `/account/v03_09/package_detail|suspend_imsi|resume_imsi|add_imsi|imsi_list|create_bundle_template|...`, token in URL path, base from `Provider.apiBaseUrl` (`url-token-connector.ts:12-15`) |
| 14 | iBASIS endpoint contract verified | ✅ | Code+test level: `Authorization: Token <token>`, `/api/v1/inventory/sims`, `/api/v1/plans`, `/api/v1/subscribers`, `/api/v1/subscriptions/activations`, suspend/restore (`ibasis-connector.ts:98`) — all exercised by test suite |
| 15 | Webhook normalization on common shape | ⚠️ | Choice/iBASIS normalizers emit `iccid`/status; **two** inbound receivers exist (`/api/providers/webhooks/[provider]` config-driven + `/api/webhooks/providers/[provider]` legacy) with different event shapes — collision documented, dedup via `externalEventId` |
| 16 | Webhook auth posture — **FIXED** + ops note | ⚠️ | Legacy route now **fail-closed in production** when `{PROVIDER}_WEBHOOK_SECRET` is unset (previously accepted any payload); query-string secret removed. ⚠️ **Ops must configure webhook auth before prod** — no `*_WEBHOOK_SECRET` vars present in `.env*` |
| 17 | Jobs/self-heal/webhook/reconciler: no billable double-calls | ✅ | `PROVIDER_OPERATION`, QR reconciliation, status/usage sync, webhook completion all poll (`getStatus`/`getQRCode`) or converge on idempotent finalizers (`completeProviderOperation` FULFILLED guard, single-shot capture, ICCID dedup) |
| 18 | Purchase at-most-once (failover + recovery) | ⚠️ | Documented MEDIUM: orchestrator failover (`purchase-orchestrator.ts:380`) and recovery redispatch (`recovery.ts:334-392`) can re-invoke `activateESIM` if a provider accepts but the response is lost. No at-most-once barrier. Recommended: reconciliation before redispatch |
| 19 | Dead code / route-collision inventory | ⚠️ | Dead: `provider-purchase.ts`, `businessTopUpEsim` action, phantom `inventory-cleanup.ts`. Collisions: two webhook receivers (see #15), duplicate `/api/esim/purchase` (legacy of canonical `/api/v1/esims/order`) |
| 20 | DB model overlap inventory | ⚠️ | `qrCodeUrl` vs `qrCode` (both live, intentional); `providerFulfillId`/`providerReservationId` mirrored on order+eSIM (needed for lookups); `providerReservationId`→`providerSubscriptionId` semantic collision — all have live readers, **no column safely deletable** |
| 21 | Admin/Business page duplication inventory | ⚠️ | `/admin/orders` vs `/admin/operations/orders` (intra-admin duplication); two status-sync engines; two top-up engines. Admin vs business separation is intentional |
| 22 | Secrets/logging/dependency sweep | ✅ | Console.log sweep clean (tokens masked); deps single-version (next 14.2.35, react 18.3.1, prisma 5.22.0); `rawMetadata` contract excludes secrets; webhook raw bodies stored to DB (documented MEDIUM, see Findings) |
| 23 | TypeScript clean | ✅ | `npx tsc --noEmit` → 0 errors |
| 24 | Production build clean | ✅ | `npm run build` → compiled, 96/96 static pages |
| 25 | Full test suite | ✅ | 100 files / 2176 tests: **2174 passed, 2 failed** — both the pre-existing Postgres-enum failures in `phase3c-integration.test.ts` (42883, environmental), identical to baseline `82fe129`. No regressions |

---

## Fixes Applied (3)

| Fix | Severity | File | Change |
|---|---|---|---|
| 1. Client provider-secret leak | HIGH | `src/app/admin/providers/[id]/page.tsx` | Sensitive config keys filtered before passing to client; raw config JSON redacted via `redactSensitiveConfig` |
| 2. Wallet TOCTOU overdraw race | HIGH | `src/lib/services/orders/wallet-actions.ts` | `reserveWalletFunds` now atomic: conditional `updateMany` (`walletBalance >= amount`) + ledger write in one transaction; idempotency check moved inside |
| 3. Webhook auth bypass | HIGH | `src/app/api/webhooks/providers/[provider]/route.ts` | Fail-closed in production when `{PROVIDER}_WEBHOOK_SECRET` unset; removed secret-in-query-string |

**Verification after fixes:** `tsc --noEmit` clean · 98 targeted order/wallet tests pass · full suite 2174/2176 (2 pre-existing) · `next build` clean.

---

## Findings Documented — NOT Fixed (approved scope 1-3)

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| F1 | CRITICAL | `topUpEsimWithWallet` (`esim-service.ts:281-383`) never collects funds — reserve/capture no-op on the purchase's existing RESERVE/CAPTURE → free top-ups via business/admin portal | **Deploy-blocking if top-up is customer-facing.** Route all top-ups through one engine with its own reservation ledger (or key top-up reserve by top-up order, not purchaseId). Do not enable top-up until fixed |
| F2 | HIGH | `createTopUpOrder` (`top-up-order.ts`) calls `adapter.topUpESIM` before any wallet debit; no reservation/idempotency → double provider charge + double debit on retry | Add pre-reservation + `providerPurchaseKey`-style idempotency; reverse on failure |
| F3 | HIGH | `processPartialFulfillment` (`fulfillment.ts:529-543`) capture math always computes `remainingToCapture = 0` → multi-batch orders under-collect. **No production caller today** (only its own test) | Fix `remainingToCapture = captureAmount`; make capture incremental (currently single-shot); wire before enabling partial fulfillment |
| F4 | HIGH | Two live webhook receivers for the same providers (`/api/providers/webhooks/[provider]` vs `/api/webhooks/providers/[provider]`) with different event shapes | Pick one canonical contract; register providers against it; delete/redirect the other after confirming provider configs |
| F5 | MEDIUM | Purchase at-most-once not guaranteed on failover/recovery redispatch (lost-response-after-acceptance) | Query provider status before redispatch; treat uncertain outcomes as reconciliation, not new activation |
| F6 | MEDIUM | Webhook raw bodies persisted unredacted to `ProviderWebhookEvent.payload` | Redact echoed auth data; keep headers filter |
| F7 | MEDIUM | `timingSafeEqual` on unequal-length buffers throws (500 instead of 401) in canonical webhook route | Length-check before compare |
| F8 | MEDIUM | Recovery lock uses unconditional upsert (`order-recovery/route.ts:12-16`) → concurrent redispatch possible | `WHERE`-guarded lock acquire |

**INFO (no action):** `/api/esim/purchase` is a legacy duplicate of canonical `/api/v1/esims/order` (no client references); `inventory-cleanup.test.ts` is a static-audit file; plaintext provider config stored in DB is admin-only (tokens remain encrypted at rest via `encryptToken`).

---

## READY Verdict

**✅ READY FOR DEPLOYMENT** for the core purchase → QR/install → fulfillment pipeline against baseline `82fe129`, with the 3 approved fixes.

All READY gates met: no duplicate purchase path ✓ · no provider factory conflict ✓ · no client provider/secrets leak ✓ (fixed) · no wallet/order race defect ✓ (TOCTOU fixed; same-order double-reserve unreachable) · Choice/iBASIS endpoint contracts verified at code+test level ✓ · QR/install pipeline canonical ✓ · tsc clean ✓ · build clean ✓ · no test regressions ✓.

**Deployment conditions (must complete before/at deploy):**
1. **Configure provider webhook auth** in production env: `{PROVIDER}_WEBHOOK_SECRET` for the legacy receiver, or `config.webhookAuth` on the canonical receiver. Without this, webhooks are rejected (fail-closed by design).
2. **Treat findings F1-F3 as deploy-blocking for the top-up feature only.** Do not expose top-up to customers until the free-top-up and double-charge paths are fixed. Core purchase is unaffected.
3. Live Choice/iBASIS read-only smoke test with staging credentials (none present in `.env*`; `ESIM_PROVIDER=mock`) before first real purchase traffic.

No code changes in this audit touch Buy eSIM, PurchaseOrchestrator, pricing, or catalog.
