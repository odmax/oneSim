# OneSim Africa — Backup & Recovery Guide

## Database Backup

### Automated Daily Backup (Recommended)
```bash
# Add to crontab (runs at 2 AM daily)
0 2 * * * pg_dump -U onesim_prod -d onesim_production --no-owner > /backups/onesim_$(date +\%Y\%m\%d).sql
```

### Manual Backup
```bash
# Staging
pg_dump -U postgres -d onesim_africa --no-owner > /backups/staging_$(date +%Y%m%d_%H%M%S).sql

# Production
pg_dump -U onesim_prod -d onesim_production --no-owner > /backups/prod_$(date +%Y%m%d_%H%M%S).sql
```

### Compressed Backup (with timestamp)
```bash
pg_dump -U onesim_prod -d onesim_production --no-owner | gzip > /backups/onesim_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Retention Policy
- Keep last 7 daily backups on disk
- Keep last 4 weekly backups (Sundays)
- Keep last 12 monthly backups (1st of month)
- Offsite backup to S3/object storage weekly

## Database Restore

### Restore from backup
```bash
# Restore staging
dropdb -U postgres onesim_africa
createdb -U postgres onesim_africa
psql -U postgres -d onesim_africa < /backups/staging_20260101.sql

# Restore production
dropdb -U onesim_prod onesim_production
createdb -U onesim_prod onesim_production
psql -U onesim_prod -d onesim_production < /backups/prod_20260101.sql
```

### Migration Rollback Strategy

If `prisma migrate deploy` causes issues:

1. Check migration history:
   ```bash
   npx prisma migrate status
   ```

2. Roll back the last migration:
   ```bash
   # Option A: Mark as rolled back (if migration is still in database)
   npx prisma migrate resolve --rolled-back 20260630000000_add_api_key_expires_at
   
   # Option B: Roll back via raw SQL (for data-destructive changes)
   psql -U postgres -d onesim_africa -c "DROP TABLE IF EXISTS new_table CASCADE;"
   psql -U postgres -d onesim_africa -c "DELETE FROM _prisma_migrations WHERE migration_name = '20260630000000_add_api_key_expires_at';"
   ```

3. Redeploy the previous version:
   ```bash
   # Revert code
   git checkout <previous-stable-tag>
   npm install
   npx prisma generate
   npm run build
   pm2 restart onesim-staging
   ```

## PM2 Recovery

PM2 auto-restarts apps on crash via PM2 config or `--restart-delay`.

### Check PM2 status
```bash
pm2 status
pm2 show onesim-staging
pm2 show onesim-production
```

### View logs
```bash
pm2 logs onesim-staging --lines 200
pm2 logs onesim-production --lines 200
pm2 logs --err --lines 50
```

### Save process list (after any change)
```bash
pm2 save
pm2 startup  # Generates systemd service for auto-start on boot
```

### Restart after server reboot
```bash
pm2 resurrect   # Restores all saved processes
```

## Nginx Recovery

### Test configuration
```bash
sudo nginx -t
```

### Reload (zero-downtime)
```bash
sudo systemctl reload nginx
```

### Restart (downtime expected)
```bash
sudo systemctl restart nginx
```

### Common Issues

1. **502 Bad Gateway**
   - App not running → `pm2 status`, `pm2 logs`
   - Port mismatch → Check `proxy_pass` in nginx config matches the PM2 port
   - Build error → `pm2 logs` will show the startup error

2. **SSL Certificate Expired**
   ```bash
   sudo certbot renew
   sudo systemctl reload nginx
   ```

3. **Database Connection Lost**
   ```bash
   systemctl status postgresql
   systemctl restart postgresql
   ```

## Environment Recovery

If `.env` files are lost, reconstruct from:

### `.env` (Staging)
```
DATABASE_URL=postgresql://postgres:0000@localhost:5432/onesim_africa
NEXTAUTH_SECRET=<set a stable secret>
NEXTAUTH_URL=https://staging.onetelecom.cloud
NEXT_PUBLIC_APP_URL=https://staging.onetelecom.cloud
ENCRYPTION_KEY=<64 hex chars>
CRON_SECRET=<random string>
EMAIL_FROM=noreply@onetelecom.cloud
EMAIL_SERVICE=log
```

### `.env.production`
```
DATABASE_URL=postgresql://onesim_prod:<password>@localhost:5432/onesim_production
NEXTAUTH_SECRET=<must be same as staging or different>
NEXTAUTH_URL=https://m2m.onetelecom.cloud
NEXT_PUBLIC_APP_URL=https://m2m.onetelecom.cloud
ENCRYPTION_KEY=<64 hex chars, different from staging>
CRON_SECRET=<random string, different from staging>
EMAIL_FROM=noreply@onetelecom.cloud
EMAIL_SERVICE=log
```
