import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const KEY = 'k'.repeat(32);
const SECRET = 's'.repeat(32);

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WA_GATEWAY_API_KEY: KEY,
    WA_WEBHOOK_URL: 'http://127.0.0.1:8000/api/v1/webhooks/whatsapp',
    WA_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
}

function problems(overrides: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error('expected loadConfig to fail');
}

describe('loadConfig', () => {
  it('test_config_defaults', () => {
    const config = loadConfig(env());
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8095,
      apiKey: KEY,
      webhookSecret: SECRET,
      webhookUrl: 'http://127.0.0.1:8000/api/v1/webhooks/whatsapp',
      authDir: './auth_state',
      dedupeFile: './data/sent-refs.json',
      dedupeTtlDays: 14,
      statusDelayMs: 2000,
      webhookRetries: 5,
      webhookRetryBaseMs: 1000,
      webhookTimeoutMs: 10000,
      logLevel: 'info',
      baileysLogLevel: 'warn',
    });
  });

  it('test_config_rejects_non_loopback_host_weak_key_and_bad_url', () => {
    const found = problems({
      GATEWAY_HOST: '0.0.0.0',
      WA_GATEWAY_API_KEY: 'short',
      WA_WEBHOOK_URL: 'ftp://example.test/hook',
      WA_WEBHOOK_SECRET: 'tiny',
    });
    expect(found.join('\n')).toMatch(/GATEWAY_HOST/);
    expect(found.join('\n')).toMatch(/WA_GATEWAY_API_KEY/);
    expect(found.join('\n')).toMatch(/WA_WEBHOOK_URL/);
    expect(found.join('\n')).toMatch(/WA_WEBHOOK_SECRET/);
    // Never echo secret values back.
    expect(found.join('\n')).not.toContain('short');
    expect(found.join('\n')).not.toContain('tiny');

    expect(problems({ WA_WEBHOOK_URL: 'not a url' }).join()).toMatch(/WA_WEBHOOK_URL/);
    expect(problems({ WA_GATEWAY_API_KEY: undefined }).join()).toMatch(/WA_GATEWAY_API_KEY/);
    expect(problems({ WA_WEBHOOK_SECRET: '' }).join()).toMatch(/WA_WEBHOOK_SECRET/);
    expect(problems({ GATEWAY_HOST: '192.168.1.10' }).join()).toMatch(/loopback/);
    // The .env.example placeholders are long enough but must not be used as real secrets.
    const placeholders = problems({
      WA_GATEWAY_API_KEY: 'change-me-to-a-long-random-key',
      WA_WEBHOOK_SECRET: 'change-me-to-another-long-random-secret',
    }).join('\n');
    expect(placeholders).toMatch(/WA_GATEWAY_API_KEY still has the placeholder/);
    expect(placeholders).toMatch(/WA_WEBHOOK_SECRET still has the placeholder/);
  });

  it('test_config_accepts_loopback_hosts_and_the_explicit_override', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST']) {
      expect(loadConfig(env({ GATEWAY_HOST: host })).host).toBe(host);
    }
    const open = loadConfig(env({ GATEWAY_HOST: '0.0.0.0', GATEWAY_ALLOW_NON_LOOPBACK: 'true' }));
    expect(open.host).toBe('0.0.0.0');
  });

  it('test_config_validates_numbers_and_levels', () => {
    expect(problems({ GATEWAY_PORT: '70000' }).join()).toMatch(/GATEWAY_PORT/);
    expect(problems({ GATEWAY_PORT: 'abc' }).join()).toMatch(/GATEWAY_PORT/);
    expect(problems({ WA_DEDUPE_TTL_DAYS: '3' }).join()).toMatch(/WA_DEDUPE_TTL_DAYS/);
    expect(problems({ WA_STATUS_DELAY_MS: '-1' }).join()).toMatch(/WA_STATUS_DELAY_MS/);
    expect(problems({ WA_WEBHOOK_RETRIES: '0' }).join()).toMatch(/WA_WEBHOOK_RETRIES/);
    expect(problems({ WA_BAILEYS_LOG_LEVEL: 'trace' }).join()).toMatch(/WA_BAILEYS_LOG_LEVEL/);
    expect(problems({ LOG_LEVEL: 'loud' }).join()).toMatch(/LOG_LEVEL/);
    expect(problems({ GATEWAY_ALLOW_NON_LOOPBACK: 'maybe' }).join()).toMatch(
      /GATEWAY_ALLOW_NON_LOOPBACK/,
    );

    const tuned = loadConfig(
      env({ GATEWAY_PORT: '9000', WA_DEDUPE_TTL_DAYS: '30', WA_WEBHOOK_RETRIES: '3' }),
    );
    expect(tuned).toMatchObject({ port: 9000, dedupeTtlDays: 30, webhookRetries: 3 });
  });
});
