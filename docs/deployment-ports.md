# OneSim Africa — Deployment Port Mapping

## Port Configuration

| Domain | Upstream Port | Environment | Purpose |
|---|---|---|---|
| `staging.onetelecom.cloud` | `3001` | Staging | Internal testing & UAT |
| `m2m.onetelecom.cloud` | `3002` | Production | Live B2B eSIM platform |

## Nginx Proxy Configuration

Each domain must proxy_pass to the corresponding localhost port:

```
# Staging
server_name staging.onetelecom.cloud;
location / {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}

# Production / M2M
server_name m2m.onetelecom.cloud;
location / {
    proxy_pass http://localhost:3002;
    proxy_http_version 1.1;
    ...
}
```

## Diagnostic Commands

```bash
# Show all proxy_pass mappings
sudo nginx -T | grep proxy_pass -n

# Test nginx configuration syntax
sudo nginx -t

# Reload nginx after config change
sudo systemctl reload nginx

# Test staging port directly (bypass nginx)
curl -I http://localhost:3001

# Test production port directly (bypass nginx)
curl -I http://localhost:3002
```

## Starting the Apps

```bash
# Staging (port 3001)
PORT=3001 NODE_ENV=production npx next start -p 3001

# Production / M2M (port 3002)
PORT=3002 NODE_ENV=production npx next start -p 3002

# Or with PM2 (recommended)
pm2 start ecosystem.config.js
```

## Environment Files

| File | Port | Domain |
|---|---|---|
| `.env` (staging default) | `3001` | `staging.onetelecom.cloud` |
| `.env.production` | `3002` | `m2m.onetelecom.cloud` |

Ensure `NEXT_PUBLIC_APP_URL` matches the domain in each .env:

```
# .env (staging)
NEXT_PUBLIC_APP_URL=https://staging.onetelecom.cloud

# .env.production
NEXT_PUBLIC_APP_URL=https://m2m.onetelecom.cloud
```

## Troubleshooting 502 Bad Gateway

1. Check if the app is running on the expected port:
   ```bash
   curl -I http://localhost:3001
   curl -I http://localhost:3002
   ```

2. Check nginx proxy_pass targets:
   ```bash
   sudo nginx -T | grep proxy_pass -n
   ```

3. Verify nginx config:
   ```bash
   sudo nginx -t
   ```

4. Reload nginx after fix:
   ```bash
   sudo systemctl reload nginx
   ```

5. Check PM2 status:
   ```bash
   pm2 status
   pm2 logs onesim-staging --lines 50
   pm2 logs onesim-production --lines 50
   ```
