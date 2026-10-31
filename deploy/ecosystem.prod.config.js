/**
 * PM2: WhatsApp gateway in production. Listens on 127.0.0.1:8095 only; never proxied by Nginx.
 * Exactly one instance: the Baileys session cannot be shared between processes.
 * The rest of the configuration comes from .env in the repo root (see .env.example).
 */
module.exports = {
  apps: [
    {
      name: 'kampusping-wa-gateway',
      cwd: __dirname + '/..',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: '8095',
      },
    },
  ],
};
