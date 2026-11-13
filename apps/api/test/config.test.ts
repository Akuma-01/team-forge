import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://local:local@127.0.0.1:54329/teamforge' };

describe('startup configuration', () => {
  it('defaults the pool to the required 20 connections', () => {
    expect(readConfig(base).PG_POOL_MAX).toBe(20);
  });

  it('requires a PostgreSQL URL and does not echo secrets on failure', () => {
    expect(() => readConfig({ DATABASE_URL: 'private-secret-not-a-url' })).toThrow('Invalid configuration: DATABASE_URL');
    expect(() => readConfig({ DATABASE_URL: 'https://example.com' })).toThrow('Invalid configuration: DATABASE_URL');
  });

  it('rejects non-origin application URLs', () => {
    expect(() => readConfig({ ...base, APP_ORIGIN: 'not-a-url' })).toThrow('APP_ORIGIN');
    expect(() => readConfig({ ...base, APP_ORIGIN: 'https://example.com/path' })).toThrow('APP_ORIGIN');
    expect(() => readConfig({ ...base, APP_ORIGIN: 'ftp://example.com' })).toThrow('APP_ORIGIN');
  });

  it('requires HTTPS in production but allows local HTTP development', () => {
    expect(() => readConfig({ ...base, NODE_ENV: 'production' })).toThrow('APP_ORIGIN');
    expect(readConfig({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'https://example.com' }).NODE_ENV).toBe('production');
  });
});
