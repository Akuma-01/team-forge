import { randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function inviteCode() {
  // Ten independent 5-bit symbols: 50 bits, with no modulo bias.
  return [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join('');
}
