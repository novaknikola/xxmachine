module.exports = {
  apps: [
    {
      name: 'xxmachine',
      cwd: '/var/www/xxmachine',
      script: 'server.mjs',
      interpreter: 'node',
      env_production: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '1500M',
      exp_backoff_restart_delay: 5000,
      merge_logs: true,
    },
  ],
}
