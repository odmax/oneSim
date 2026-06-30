# OneSim Africa — Launch Checklist

## Pre-Launch Configuration

### Environment Variables
- [ ] `.env.production` exists with production database credentials
- [ ] `DATABASE_URL` points to `onesim_production` database
- [ ] `NEXTAUTH_SECRET` set to a stable, random 64-character string
- [ ] `NEXTAUTH_URL` set to `https://m2m.onetelecom.cloud`
- [ ] `NEXT_PUBLIC_APP_URL` set to `https://m2m.onetelecom.cloud`
- [ ] `ENCRYPTION_KEY` set to a 64-hex-char random string (different from staging)
- [ ] `CRON_SECRET` set to a random string (different from staging)
- [ ] `EMAIL_FROM` set to `noreply@onetelecom.cloud`
- [ ] `EMAIL_SERVICE` configured (sendgrid or smtp for production)

### Database
- [ ] Production PostgreSQL database created: `onesim_production`
- [ ] Production user created: `onesim_prod` with secure password
- [ ] Migrations applied: `npx prisma migrate deploy`
- [ ] Database schema verified: `npx prisma migrate status`
- [ ] Backup configured (daily cron job)
- [ ] Backup retention policy implemented

### Seed Data
- [ ] Super admin user created (email + set-password)
- [ ] Test business created and approved
- [ ] Provider templates seeded (AirHub, Rakuten, Choice)
- [ ] Provider records created (with staging credentials initially)
- [ ] At least one provider connected and authenticated
- [ ] Provider plans synced and imported
- [ ] At least one provider certified
- [ ] eSIM packages configured and published to catalog
- [ ] Business API key generated for testing

## Deployment

### PM2 Process Management
- [ ] App deployed to production server
- [ ] PM2 process `onesim-production` running on port 3002
- [ ] PM2 save executed (`pm2 save`)
- [ ] PM2 startup configured (`pm2 startup`)
- [ ] PM2 restart tested
- [ ] Auto-restart on crash verified

### Nginx Configuration
- [ ] `m2m.onetelecom.cloud` proxied to `localhost:3002`
- [ ] `staging.onetelecom.cloud` proxied to `localhost:3001`
- [ ] SSL certificates installed (`certbot`)
- [ ] SSL auto-renewal configured
- [ ] `nginx -t` passes
- [ ] WebSocket support enabled (Upgrade/Connection headers)
- [ ] Rate limiting configured at nginx level (optional)

### Health Checks
- [ ] `GET /api/health` returns 200
- [ ] `GET /api/health/db` returns 200
- [ ] `GET /api/health/providers` returns 200
- [ ] `GET /api/health/cron` returns 200

## Functional Testing

### Authentication
- [ ] Admin login works
- [ ] Business user login works
- [ ] Pending business redirected to /business/pending
- [ ] Suspended business receives clear error
- [ ] Password reset flow works
- [ ] Session persists across page loads

### eSIM Purchase Flow
- [ ] Business can view available packages
- [ ] Wallet balance displayed correctly
- [ ] Purchase creates order with CREATED status
- [ ] Wallet funds reserved
- [ ] Provider dispatch succeeds
- [ ] eSIM records created with ICCID
- [ ] Wallet funds captured on success
- [ ] Order visible in admin and business order lists
- [ ] Correct redirect to order detail page

### Usage & Lifecycle
- [ ] eSIM detail shows usage bar with percentage
- [ ] Refresh Status updates provider status
- [ ] Refresh Usage creates usage record
- [ ] Expired eSIMs marked correctly
- [ ] Top-up flow works end-to-end
- [ ] Wallet reserve/capture/release for top-up

### Billing & Invoicing
- [ ] Wallet ledger shows all transactions
- [ ] Invoice generated for purchases
- [ ] Invoice generated for top-ups
- [ ] Manual invoice creation works
- [ ] Invoice detail page shows line items
- [ ] Finance dashboard shows revenue/profit/refunds

### Public API
- [ ] x-api-key authentication works
- [ ] Rate limit headers returned correctly
- [ ] Idempotency prevents duplicate orders
- [ ] OpenAPI spec accessible at /api/docs/openapi.json
- [ ] All v1 endpoints respond without errors

### Webhooks
- [ ] Webhook endpoint creation works
- [ ] Test webhook sent successfully
- [ ] Delivery history tracked
- [ ] Failed webhooks retried
- [ ] HMAC signature verification passes

### Provider Operations
- [ ] Provider authentication works for all providers
- [ ] Test connection succeeds for all providers
- [ ] Plan sync works (at least 5+ plans fetched)
- [ ] Plan import creates correct eSIM packages
- [ ] Certification wizard advances through steps

## Monitoring

### Cron Jobs
- [ ] `/api/cron/process-webhooks` — processes pending webhooks
- [ ] `/api/cron/provider-health` — checks provider connectivity
- [ ] `/api/cron/refresh-esims` — refreshes active eSIM statuses
- [ ] `/api/cron/sync-esim-status` — syncs provider-side status
- [ ] `/api/cron/process-jobs` — processes background jobs
- [ ] CRON_SECRET authentication configured

### Alerting
- [ ] Webhook delivery failures tracked
- [ ] Provider degraded/offline visible in alerts
- [ ] Failed orders visible from alerts page
- [ ] System monitoring dashboard operational

## Rollback Preparedness

### Rollback Steps Documented
- [ ] Git revert procedure tested
- [ ] Database migration rollback understood
- [ ] PM2 previous version restart documented
- [ ] Backup restore tested

### Backup Verification
- [ ] Manual backup created and verified
- [ ] Restore from backup tested on staging
- [ ] Backup automation (cron) configured

## Go/No-Go Checklist

### Must Pass (blocking)
- [ ] All health endpoints return 200
- [ ] Admin login + dashboard loads
- [ ] Business login + buy flow works
- [ ] At least one provider authenticated and certified
- [ ] eSIM purchase creates order + ICCID
- [ ] Wallet balance updates correctly
- [ ] API key authentication works
- [ ] SSL certificate valid

### Should Pass (high priority)
- [ ] Top-up flow works
- [ ] Usage refresh works
- [ ] Webhooks deliver correctly
- [ ] Invoices generated automatically
- [ ] Finance dashboard shows accurate data
- [ ] Monitoring dashboard loads

### Nice-to-Have (non-blocking)
- [ ] ALL providers certified
- [ ] Developer guide fully populated
- [ ] SDK examples tested
- [ ] Custom domain email configured
- [ ] Rate limiting tuned per business

## Post-Launch

- [ ] Monitor error logs for 24 hours
- [ ] Verify cron jobs ran overnight
- [ ] Check wallet balance consistency
- [ ] Verify all provider syncs ran
- [ ] Review API analytics for anomalies
- [ ] Confirm backup ran successfully
- [ ] Update staging environment to match production config
