import { describe, expect, it } from 'vitest';
import { loginSchema, profilePatchSchema, signupSchema } from '../src/index.js';

describe('shared identity validation', () => {
  it('normalizes surrounding spaces without changing passwords', () => {
    expect(loginSchema.parse({ email: ' BUILDER@example.test ', password: '  password  ' })).toEqual({ email: 'builder@example.test', password: '  password  ' });
    expect(profilePatchSchema.parse({ displayName: ' Builder ' })).toEqual({ displayName: 'Builder' });
  });
  it('rejects ASCII and Unicode controls before trimming', () => {
    for (const value of ['\nBuilder', 'Builder\t', 'B\u0085uilder', 'B\u007fuilder', 'B\u0000uilder']) {
      expect(profilePatchSchema.safeParse({ displayName: value }).success).toBe(false);
    }
    expect(loginSchema.safeParse({ email: '\tbuilder@example.test', password: 'valid-password' }).success).toBe(false);
  });
  it('enforces the password limits and preserves international display names', () => {
    const input = { email: 'builder@example.test', displayName: 'アキラ' };
    for (const length of [10, 128]) expect(signupSchema.safeParse({ ...input, password: 'a'.repeat(length) }).success).toBe(true);
    for (const length of [9, 129]) expect(signupSchema.safeParse({ ...input, password: 'a'.repeat(length) }).success).toBe(false);
  });
});
