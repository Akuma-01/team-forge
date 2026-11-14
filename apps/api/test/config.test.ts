import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://local:local@127.0.0.1:54329/teamforge', JWT_SECRET: 'test-only-secret-0123456789abcdef0123456789' };

describe('startup configuration', () => {
  it('requires a non-placeholder JWT secret without echoing it', () => {
    for (const secret of ['', 'short', 'replace-with-a-strong-secret-of-32-bytes']) {
      expect(() => readConfig({ ...base, JWT_SECRET: secret })).toThrow('Invalid configuration: JWT_SECRET');
    }
    expect(() => readConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow('JWT_SECRET');
  });
  it('trusts no proxies by default and only accepts explicit addresses or CIDRs', () => {
    expect(readConfig(base).TRUSTED_PROXY_CIDRS).toEqual([]);
    expect(readConfig({ ...base, TRUSTED_PROXY_CIDRS: '127.0.0.1/32, ::1/128' }).TRUSTED_PROXY_CIDRS).toEqual(['127.0.0.1/32', '::1/128']);
    for (const value of ['true', '1', 'loopback', '127.0.0.1/33', '::1/129', '127.0.0.1/32//extra']) {
      expect(() => readConfig({ ...base, TRUSTED_PROXY_CIDRS: value })).toThrow('TRUSTED_PROXY_CIDRS');
    }
  });
  it('defaults the pool to the required 20 connections', () => {
    expect(readConfig(base).PG_POOL_MAX).toBe(20);
  });

  it('requires a PostgreSQL URL and does not echo secrets on failure', () => {
    expect(() => readConfig({ ...base, DATABASE_URL: 'private-secret-not-a-url' })).toThrow('Invalid configuration: DATABASE_URL');
    expect(() => readConfig({ ...base, DATABASE_URL: 'https://example.com' })).toThrow('Invalid configuration: DATABASE_URL');
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
