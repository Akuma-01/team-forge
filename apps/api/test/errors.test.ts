import { describe, expect, it } from 'vitest';
import { AppError, mapPgError } from '../src/db/errors.js';
import { requireTestDatabase } from './helpers/database.js';

describe('named PostgreSQL error mapping', () => {
  it.each([
    ['23514', 'teams_not_overfull', 'TEAM_FULL', 409],
    ['23505', 'team_members_one_team_per_hackathon', 'ALREADY_IN_TEAM', 409],
    ['23505', 'teams_name_per_hackathon_uq', 'TEAM_NAME_TAKEN', 409],
    ['23503', 'team_members_team_fk', 'TEAM_NOT_FOUND', 404],
    ['23503', 'teams_leader_is_member_fk', 'INTERNAL', 500],
    ['23514', 'teams_member_count_matches', 'INTERNAL', 500],
    ['23505', 'join_requests_one_pending_uq', 'INTERNAL', 500],
    ['23505', 'unknown_constraint', 'INTERNAL', 500],
    ['23503', 'teams_not_overfull', 'INTERNAL', 500],
  ])('maps %s / %s to %s', (code, constraint, expected, status) => {
    const result = mapPgError({ code, constraint, detail: 'private data' });
    expect(result).toMatchObject({ code: expected, status });
    expect(result.message).not.toContain('private data');
  });

  it.each(['40P01', '40001', '55P03', '57014'])('maps exhausted/timeout %s to BUSY', (code) => {
    expect(mapPgError({ code })).toMatchObject({ code: 'BUSY', status: 503, retryAfter: 1 });
  });

  it('preserves domain errors and sanitizes unknown failures', () => {
    const error = new AppError('FORBIDDEN', 403, 'Forbidden.');
    expect(mapPgError(error)).toBe(error);
    expect(mapPgError(undefined)).toMatchObject({ code: 'INTERNAL' });
    expect(mapPgError(new Error('private detail')).message).not.toContain('private detail');
  });
});

describe('disposable database guard', () => {
  it.each([
    undefined,
    'not-a-url',
    'postgres://localhost/teamforge',
    'postgres://remote.example/teamforge_test',
    'https://localhost/teamforge_test',
    'postgres://localhost/teamforge_test?host=remote.example',
    'postgres://localhost/teamforge_test?dbname=live',
  ])('refuses unsafe or unspecified test configuration: %s', (url) => {
    expect(() => requireTestDatabase(url ? { TEST_DATABASE_URL: url } : {})).toThrow('dedicated database');
  });
  it('accepts the dedicated local test database', () => {
    const url = 'postgres://localhost:54330/teamforge_test';
    expect(requireTestDatabase({ TEST_DATABASE_URL: url })).toBe(url);
  });
});
