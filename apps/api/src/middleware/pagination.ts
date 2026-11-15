import type { z } from 'zod';
import { AppError } from '../db/errors.js';
import { validate } from './validate.js';

export function encodeCursor(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decodeCursor<T>(schema: z.ZodType<T>, cursor: string): T {
  let value: unknown;
  try {
    const buffer = Buffer.from(cursor, 'base64url');
    if (buffer.toString('base64url') !== cursor) throw new Error('Noncanonical cursor');
    value = JSON.parse(buffer.toString('utf8'));
  } catch { throw new AppError('VALIDATION_ERROR', 400, 'Invalid pagination cursor.'); }
  return validate(schema, value);
}
