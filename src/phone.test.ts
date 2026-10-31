import { describe, expect, it } from 'vitest';

import { maskPhone, phoneToJid, redactDigits } from './phone.js';

describe('phone helpers', () => {
  it('test_phone_to_jid_strips_plus', () => {
    expect(phoneToJid('+6281234567890')).toBe('6281234567890@s.whatsapp.net');
    expect(phoneToJid('6281234567890')).toBe('6281234567890@s.whatsapp.net');
  });

  it('test_mask_phone_keeps_only_the_last_four_digits', () => {
    expect(maskPhone('+6281234567890')).toBe('******7890');
    expect(maskPhone('')).toBe('******');
  });

  it('test_redact_digits_masks_phone_like_runs_in_free_text', () => {
    const text = 'jid 6281234567890@s.whatsapp.net failed (+6289999999999), code 428';
    const redacted = redactDigits(text);
    expect(redacted).not.toContain('6281234567890');
    expect(redacted).not.toContain('6289999999999');
    expect(redacted).toContain('******7890');
    expect(redacted).toContain('code 428');
  });
});
