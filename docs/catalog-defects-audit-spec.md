# Read-only Audit Specification — Catalog Editing & Customer Visibility

This is the **read-only** audit to run separately against **staging** to
confirm the two catalog defects and validate the code fix. It makes **no
writes** — no prisma create/update/delete, no raw DML, no provider HTTP calls,
no publish/finalize/recalculate. Run it yourself; I do not access AWS, Vector,
the remote database, or any provider.

## Prerequisites

- Checkout `staging` at `8ca8f097f5d16b51873e09c94adad22481b28994` or the
  proposed fix branch.
- Environment: staging `DATABASE_URL` for the read-only connection
  (or a read replica); `.env` loaded.

## 1. Repeat-editing reproduction (was "edited successfully only once")

Manual, in the Admin → Provider Catalog → **Configure Package** modal:

1. Pick a PUBLISHED product (Publish Status = PUBLISHED). Change only the
   Selling Price; Save. Reopen → the price you entered must be shown.
2. Change the Selling Price again and Save. It must persist again (this is the
   "repeated edit" case that used to silently revert / fail).
3. Edit a second, different product. Its persisted values must load in the
   modal (per-package state) and save independently.
4. Enter a comma-decimal price (`21,49`) and Save. Reopen: it must show
   `21.49` — never `21`, `2149`, or `0`.

Read-only DB checks after the manual run (staging):

```sql
-- Sanity: no selling price stored with a truncated fraction from comma parsing
SELECT id, "sellingPrice"::text, "markupPercent"::text
FROM provider_packages
WHERE "sellingPrice"::text ~ '[0-9],' OR "markupPercent"::text ~ ',[0-9]';
```

## 2. Customer-visibility count divergence (66 / 64 / 2 vs ~20–24)

Run the existing diagnostics **in read-only mode** (they never write):

```bash
npx tsx scripts/diag-catalog-visibility.ts            # stage-by-stage counts
npx tsx scripts/diag-catalog-buy-parity.ts            # admin vs buy parity
npx tsx scripts/diag-catalog-visibility.ts --provider-code=CHOICE
```

Expected evidence:

- `INITIAL_RETAIL_CANDIDATES` (Product Catalog total ≈ 66)
- `PURCHASE_READY`  (≈ 64, "Operational Live")
- `PURCHASE_NOT_READY` with exact canonical reasons (the ≈ 2 "Needs Pricing")
- `PORTAL_FINAL_COUNT` / `API_FINAL_COUNT` and `PORTAL_BY_PROVIDER`
  (this is the client-visible set — compare to the business Buy catalog)
- Per-provider `portalPurchase` / `apiPurchase` exposure states
- "Why operationally-live products are not customer-visible" on
  `/admin/packages` (stale-price list and exposure-OFF list)

Additional read-only SQL for the parity-vs-exposure attribution:

```sql
-- Stale retail price candidates (retail price ≠ provider selling price):
SELECT e.id, e."priceUSD"::text AS retail, p."sellingPrice"::text AS pp_sell
FROM esim_packages e
JOIN provider_packages p ON p.id = e."providerPackageId"
WHERE e."isActive" AND e."source" IN ('CATALOG_PRODUCT','MANUAL')
  AND ABS(e."priceUSD"::numeric - COALESCE(p."sellingPrice",0)::numeric) >= 0.005;

-- Explicit exposure rows that affect portal visibility:
SELECT "providerId", capability, "clientPortalEnabled", "clientApiEnabled"
FROM provider_capability_exposure;
```

Compare the two sets: products excluded ONLY by exposure (provider privacy,
intentional) vs products excluded ONLY by parity (stale price → repair by
re-syncing/re-editing the price). Both must be visible in the per-reason list
on `/admin/packages`.

## 3. Pagination reachability (business Buy eSIM)

1. `/business/buy-esim` shows "Showing N of M packages" with a **Load More**
   control when `M > 24`. Click Load More until all `M` are rendered.
2. The first 24 cards must be identical after a refresh (stable page boundary,
   ID tiebreaker ordering).
3. Search/filter/sort a term that only matches a product deeper in the list;
   it must be reachable (search runs over the full eligible set) and the
   pagination must reset to the first window.
4. Confirm no card repeats across Load More (dedup by id).

## 4. No-migration / no-deploy

- No schema change is part of the fix: `npx prisma validate` passes and no
  migration is generated. Do not create one.
- Do not deploy or run repair scripts (`repair-*`) unless explicitly approved;
  this spec is diagnostics-only.

## Success criteria

- Repeated edits persist; no implicit re-publish on a PUBLISHED product.
- `21,49` persists as `21.49`.
- `/admin/packages` shows Product Catalog / Operational Live / Customer-visible
  / Draft / Needs Pricing, with an explicit reason list for the gap.
- Business Buy eSIM + `/api/v1/packages` expose exactly the Customer-visible
  set with Load More reachability and stable ordering.