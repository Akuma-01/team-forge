import { z } from 'zod';

// Browser-safe contracts only. Database records and password hashes stay in the API.
export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_LEADER',
  'NOT_REGISTERED', 'NOT_FOUND', 'TEAM_NOT_FOUND', 'INVALID_OR_EXPIRED_CODE',
  'NOT_A_MEMBER', 'TEAM_FULL', 'ALREADY_IN_TEAM', 'TEAM_CLOSED',
  'TEAM_NAME_TAKEN', 'TOO_MANY_PENDING', 'REQUEST_NOT_PENDING',
  'CANNOT_REMOVE_LEADER', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED', 'BUSY', 'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string().uuid(),
  }).strict(),
}).strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthSchema = z.object({ status: z.literal('ok') }).strict();
export type Health = z.infer<typeof healthSchema>;

export const skills = [
  'frontend', 'backend', 'design', 'ml', 'data',
  'mobile', 'devops', 'security', 'product', 'blockchain',
] as const;
export const skillSchema = z.enum(skills);
export type Skill = z.infer<typeof skillSchema>;

export type BoardTeam = {
  id: string;
  name: string;
  description: string;
  lookingFor: Skill[];
  memberCount: number;
  minSize: number;
  maxSize: number;
  openSeats: number;
  ready: boolean;
  leader: { id: string; displayName: string };
  version: number;
  createdAt: string;
};

export type TeamDetail = BoardTeam & {
  isOpen: boolean;
  members: {
    userId: string;
    displayName: string;
    skills: Skill[];
    utcOffsetMin: number;
    isLeader: boolean;
    joinedAt: string;
  }[];
  inviteCode?: string;
  inviteExpiresAt?: string;
  pendingRequestCount?: number;
};
