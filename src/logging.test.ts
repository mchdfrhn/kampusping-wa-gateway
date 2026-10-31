import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createBaileysLogger, createLogger } from './logging.js';
import { captureLogger } from './test/fakes.js';

describe('logging', () => {
  it('test_baileys_logger_masks_jids_and_drops_message_content', () => {
    const { logger, lines } = captureLogger('trace');
    const baileys = createBaileysLogger(logger, 'info');

    baileys.warn(
      {
        attrs: { from: '6281234567890@s.whatsapp.net', id: '3EB0AB' },
        message: { conversation: 'Tagihan SPP Anda belum dibayar' },
        pushName: 'Budi Santoso',
        creds: { noiseKey: 'private' },
        node: { content: Buffer.from('raw') },
      },
      'received error in ack from 6281234567890',
    );
    baileys.error(new Error('failed for 6289999999999@s.whatsapp.net'), 'send failed');
    baileys.child({ jid: '6281111111111@s.whatsapp.net' }).info('connected');
    baileys.info('plain string message for 6282222222222');

    const output = lines.join('\n');
    expect(lines).toHaveLength(4);
    expect(output).toContain('7890');
    expect(output).toContain('3EB0AB');
    for (const secret of [
      '6281234567890',
      '6289999999999',
      '6281111111111',
      '6282222222222',
      'Tagihan',
      'Budi',
      'private',
      'raw',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('test_baileys_logger_respects_its_level', () => {
    const { logger, lines } = captureLogger('trace');
    const baileys = createBaileysLogger(logger, 'warn');
    expect(baileys.level).toBe('warn');
    baileys.trace({ a: 1 }, 'trace');
    baileys.debug({ a: 1 }, 'debug');
    baileys.info({ a: 1 }, 'info');
    baileys.child({ b: 2 }).info('child info');
    expect(lines).toEqual([]);
    baileys.warn({ a: 1 }, 'warn');
    baileys.child({ b: 2 }).error('child error');
    expect(lines).toHaveLength(2);

    const silent = createBaileysLogger(logger, 'silent');
    silent.error('nothing');
    expect(lines).toHaveLength(2);
  });

  it('test_root_logger_redacts_secret_fields', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger('info', stream);
    logger.info(
      {
        authorization: 'Bearer top-secret',
        text: 'Halo Budi',
        req: { headers: { authorization: 'x' } },
      },
      'hello',
    );
    const output = lines.join('\n');
    expect(output).toContain('hello');
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('Halo Budi');
  });
});
