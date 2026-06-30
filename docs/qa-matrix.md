# OneSim Africa — End-to-End QA Matrix

## Admin Flows

| # | Flow | Steps | Expected | Status |
|---|---|---|---|---|
| 1 | Admin Login | Navigate to /login → enter credentials → submit | Redirected to /admin/dashboard | ✅ |
| 2 | Dashboard Stats | View /admin/dashboard | Total businesses, pending approvals, orders, revenue | ✅ |
| 3 | Create Business | /admin/businesses/new → fill form → submit | Business created with PENDING status | ✅ |
| 4 | Approve Business | /admin/businesses → click business → Approve | Status → APPROVED, user can login | ✅ |
| 5 | Suspend Business | /admin/businesses → click business → Suspend | Status → SUSPENDED, user blocked from login | ✅ |
| 6 | Assign Sales Agent | /admin/businesses/[id]/edit → select sales agent → save | assignedSalesUserId set | ✅ |
| 7 | Create Admin User | /admin/users/new → fill form (role/email/name) → submit | Admin user created, set-password email sent | ✅ |
| 8 | Role Check | Verify SUPER_ADMIN can view all, SALES_TEAM limited | Permissions respected | ✅ |
| 9 | Provider Create | /admin/providers/new → select type → fill config → submit | Provider created, redirected to setup | ✅ |
| 10 | Provider Auth | Provider detail → enter credentials → Authenticate | Token stored, status updated | ✅ |
| 11 | Provider Test | Provider detail → Test Connection | Success/failure with latency | ✅ |
| 12 | Provider Sync | Provider detail → Sync Plans | Plans fetched and displayed in import table | ✅ |
| 13 | Provider Certify | Provider detail → certification wizard → advance steps | Status progresses toward CERTIFIED | ✅ |
| 14 | Import Plan | Provider plans → click Import → configure package | ESIMPackage created from provider plan | ✅ |
| 15 | View Orders | /admin/orders → filter by status, search | Orders display with eSIM/provider info | ✅ |
| 16 | Retry Failed Order | /admin/orders/[id] → Retry button | Order re-dispatched to provider | ✅ |
| 17 | Cancel Order | /admin/orders/[id] → Cancel button | Wallet released, status → CANCELLED | ✅ |
| 18 | Refund Order | /admin/orders/[id] → Refund button | Wallet refunded, timeline updated | ✅ |
| 19 | Order Timeline | Order detail → scroll to timeline | All status changes, wallet events, lifecycle events shown | ✅ |
| 20 | View eSIMs | /admin/esims → filter by business/status/ICCID | eSIM list with status, expiry, activation | ✅ |
| 21 | eSIM Usage | /admin/esims/[id] → usage section | Usage bar with percentage, data used/remaining | ✅ |
| 22 | Refresh eSIM | /admin/esims/[id] → Refresh Status/Usage | Data updated, timeline event created | ✅ |
| 23 | Top-Up eSIM | /admin/esims/[id]/top-up → select package → submit | Wallet deducted, eSIM expiry extended | ✅ |
| 24 | Invoice List | /admin/invoices → filter/search | All invoices with status badges | ✅ |
| 25 | Invoice Create | /admin/invoices/new → fill line items → generate | Invoice created with PAID/DRAFT status | ✅ |
| 26 | Invoice Detail | /admin/invoices/[id] | Invoice with business, amount, line items, actions | ✅ |
| 27 | Finance Dashboard | /admin/finance → period selector | Revenue, profit, refunds, wallet balance | ✅ |
| 28 | System Monitoring | /admin/monitoring | DB status, provider health, cron status | ✅ |
| 29 | Alerts & Events | /admin/alerts | Notification timeline, error/warning counts | ✅ |
| 30 | API Analytics | /admin/api-analytics | Request counts, latency, error rates | ✅ |
| 31 | Business Wallet | /admin/businesses/[id]/wallet/credit | Credit allocation creates wallet transaction | ✅ |

## Business User Flows

| # | Flow | Steps | Expected | Status |
|---|---|---|---|---|
| 32 | Login (Approved) | /login → business credentials → submit | Redirected to /business/dashboard | ✅ |
| 33 | Login (Pending) | /login → pending business credentials | Redirected to /business/pending | ✅ |
| 34 | Login (Suspended) | /login → suspended business credentials | Error message displayed | ✅ |
| 35 | Buy eSIM | /business/buy-esim → select package → set qty → Buy Now | Order created, wallet deducted, redirect to order detail | ✅ |
| 36 | View Orders | /business/orders | Filtered order list with status badges | ✅ |
| 37 | Order Detail | /business/orders/[id] | Package, eSIM details, QR, usage, timeline | ✅ |
| 38 | View eSIMs | /business/esims | ICCID, package, customer, status, delivery | ✅ |
| 39 | eSIM Usage | /business/esims → click Refresh Status/Usage | Data updated | ✅ |
| 40 | Top-Up eSIM | /business/esims/[id]/top-up | Top-up package select, wallet deduction | ✅ |
| 41 | Create Customer | /business/customers/new → fill form | Customer added to business | ✅ |
| 42 | API Keys | /business/api-keys → create/revoke | Key hash stored, key shown once | ✅ |
| 43 | API Guide | /business/developers | cURL examples, auth guide, package list | ✅ |
| 44 | Webhooks | /business/webhooks → create/test | Test webhook sent, delivery recorded | ✅ |
| 45 | Wallet | /business/wallet | Balance, transactions, credit request | ✅ |
| 46 | Team Members | /business/users → invite | Invitation sent with set-password link | ✅ |

## API Flows

| # | Endpoint | Method | Expected | Status |
|---|---|---|---|---|
| 47 | /packages | GET | Active packages list | ✅ |
| 48 | /esims/order | POST | Order created with eSIM data | ✅ |
| 49 | /esims/order (Idempotent) | POST + Idempotency-Key | Same response, no duplicate order | ✅ |
| 50 | /orders | GET | Business orders list | ✅ |
| 51 | /orders/{id} | GET | Order details with eSIMs | ✅ |
| 52 | /esims/{id} | GET | eSIM details with usage | ✅ |
| 53 | /esims/{id}/usage | GET | Usage data + history | ✅ |
| 54 | /esims/{id}/top-up | POST | Top-up completed | ✅ |
| 55 | /customers | GET/POST | Customer list / create | ✅ |
| 56 | /customers/{id} | GET/PATCH | Customer detail / update | ✅ |
| 57 | /wallet | GET | Wallet balance + stats | ✅ |
| 58 | /wallet/transactions | GET | Paginated transaction list | ✅ |
| 59 | /auth/verify | GET | Authentication status | ✅ |
| 60 | /webhooks | GET/POST | Webhook list / create | ✅ |
| 61 | /webhooks/{id}/test | POST | Test webhook sent | ✅ |
| 62 | /webhooks/{id}/deliveries | GET | Delivery history | ✅ |
| 63 | /webhooks/deliveries/{id}/retry | POST | Delivery retried | ✅ |

## Provider Flows

| # | Provider | Auth | Sync | Purchase | Top-Up | Status |
|---|---|---|---|---|---|---|
| 64 | AirHub | ✅ | ✅ | Pending (requires real provider) | N/A | Template |
| 65 | Rakuten | ✅ | ✅ | Pending (requires staging credentials) | N/A | Template |
| 66 | Choice/PSA | ✅ | ✅ | Pending (requires real provider) | Pending | URL_TOKEN |

## Wallet Safety

| # | Scenario | Expected | Status |
|---|---|---|---|
| 67 | Purchase → reserve wallet → provider success → capture | Wallet deducted once at reserve, captured at provider success | ✅ |
| 68 | Purchase → reserve wallet → provider failure → release | Wallet deducted at reserve, refunded at failure | ✅ |
| 69 | Double reserve attempt | Idempotent — returns existing reserve | ✅ |
| 70 | Refund without capture | Blocked with error message | ✅ |
| 71 | Cancel order before provider dispatch | Wallet released, no provider call | ✅ |

## Security

| # | Check | Expected | Status |
|---|---|---|---|
| 72 | Cross-business data access | Business users only see own data via businessId scoping | ✅ |
| 73 | Admin role enforcement | requirePermission() on sensitive operations | ✅ |
| 74 | API key hashing | SHA-256 at rest, raw key never stored | ✅ |
| 75 | Provider token encryption | AES-256-GCM at rest | ✅ |
| 76 | Secrets masked in logs | Password/token/API key patterns masked | ✅ |
| 77 | NEXTAUTH_SECRET required in production | Validated at startup | ✅ |
| 78 | Last SUPER_ADMIN protection | Cannot delete last SUPER_ADMIN | ✅ |
| 79 | Provider LIVE requires CERTIFIED | Blocked until certified | ✅ |
