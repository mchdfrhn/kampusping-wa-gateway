/**
 * Phone helpers. Phone numbers are personal data (UU PDP): logs only ever show the last four
 * digits, in the same format as the backend's `mask_phone` (six asterisks + last four).
 */

const MASK = '******';
const VISIBLE_DIGITS = 4;
// Runs of 8+ digits look like phone numbers or JIDs (`6281234567890@s.whatsapp.net`).
const PHONE_LIKE = /\+?\d{8,}/g;

export function maskPhone(phone: string): string {
  return MASK + phone.slice(-VISIBLE_DIGITS);
}

/** `+6281234567890` -> `6281234567890@s.whatsapp.net` (WhatsApp user JIDs carry no `+`). */
export function phoneToJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** Mask every phone-like digit run in free text (error messages from libraries). */
export function redactDigits(text: string): string {
  return text.replace(PHONE_LIKE, (match) => maskPhone(match));
}
