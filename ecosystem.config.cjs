module.exports = {
  apps: [
    {
      // Virtual display for Playwright's headless:false browser-login flows
      // (Instagram private-API connect, Meta admin dashboard automation) —
      // without this, those crash on the VPS with "missing X server".
      name: 'xvfb',
      script: '/usr/bin/Xvfb',
      args: ':99 -screen 0 1920x1080x24 -nolisten tcp',
      interpreter: 'none',
      autorestart: true,
    },
    {
      name: 'xxmachine',
      cwd: '/var/www/xxmachine',
      script: 'server.mjs',
      interpreter: 'node',
      env_production: {
        NODE_ENV: 'production',
        DISPLAY: ':99',
      },
      max_memory_restart: '1500M',
      exp_backoff_restart_delay: 5000,
      merge_logs: true,
    },
  ],
}
