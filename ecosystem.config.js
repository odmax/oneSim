module.exports = {
  apps: [{
    name: process.env.PM2_APP_NAME || 'onesim-test',
    script: 'npm',
    args: 'start',
    env: {
      PORT: process.env.PORT || '3001',
      NODE_ENV: 'production',
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    restart_delay: 5000,
    max_restarts: 10,
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
}
