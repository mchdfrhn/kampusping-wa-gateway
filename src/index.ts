/**
 * Entry point: `node dist/index.js` (PM2 app `kampusping-wa-gateway`) or `npm run dev`.
 * Reads `.env` from the working directory when present (real environment variables win),
 * validates the configuration, then serves the API on GATEWAY_HOST:GATEWAY_PORT.
 */
import { existsSync } from 'node:fs';

import { createBaileysClient } from './baileys.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createGateway } from './server.js';

function loadDotEnv(): void {
  // process.loadEnvFile exists from Node 20.12; it never overrides variables already set.
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
}

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  const client = createBaileysClient({
    authDir: config.authDir,
    logger,
    baileysLogLevel: config.baileysLogLevel,
  });
  const gateway = await createGateway({ config, client, logger });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    gateway.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err_type: (error as Error).name }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const address = await gateway.listen();
  logger.info({ address }, 'WhatsApp gateway listening');
}

main().catch((error: unknown) => {
  console.error(
    'WhatsApp gateway failed to start:',
    (error as Error).name,
    (error as Error).message,
  );
  process.exit(1);
});
