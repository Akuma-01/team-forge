import type { ErrorCode } from '@teamforge/shared';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function pgDiagnostic(error: unknown): { code?: string; constraint?: string } {
  if (!error || typeof error !== 'object') return {};
  return {
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...('constraint' in error && typeof error.constraint === 'string' ? { constraint: error.constraint } : {}),
  };
}

export function busyError() {
  return new AppError('BUSY', 503, 'The database is busy. Please retry.', 1);
}

// Do not log SQL, parameters, connection strings or PostgreSQL detail fields.
export function logDatabaseError(event: string, error: unknown) {
  console.error(JSON.stringify({ event, ...pgDiagnostic(error) }));
}

export function mapPgError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const { code, constraint } = pgDiagnostic(error);
  if (code === '23514' && constraint === 'teams_not_overfull') {
    return new AppError('TEAM_FULL', 409, 'This team has no open seats.');
  }
  if (code === '23505' && constraint === 'team_members_one_team_per_hackathon') {
    return new AppError('ALREADY_IN_TEAM', 409, 'You already belong to a team in this hackathon.');
  }
  if (code === '23505' && constraint === 'teams_name_per_hackathon_uq') {
    return new AppError('TEAM_NAME_TAKEN', 409, 'This team name is already in use.');
  }
  if (code === '23503' && constraint === 'team_members_team_fk') {
    return new AppError('TEAM_NOT_FOUND', 404, 'Team not found.');
  }
  if (['55P03', '57014', '40P01', '40001'].includes(code ?? '')) return busyError();
  // Pending-request duplicates need a service-level ON CONFLICT read, not a made-up HTTP success.
  return new AppError('INTERNAL', 500, 'An unexpected error occurred.');
}
