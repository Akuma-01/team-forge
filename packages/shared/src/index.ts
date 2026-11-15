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
    details: z.array(z.object({ field: z.string(), message: z.string() }).strict()).optional(),
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

const noControls = (value: string) => !/\p{Cc}/u.test(value);
const safeText = z.string().refine(noControls, 'Control characters are not allowed.');
const displayNameSchema = safeText.transform((value) => value.trim()).pipe(z.string().min(1).max(60));
const emailSchema = safeText.transform((value) => value.trim().toLowerCase()).pipe(z.string().max(254).email());
const passwordSchema = z.string().min(10).max(128).refine(noControls, 'Control characters are not allowed.');
const skillsSchema = z.array(skillSchema).max(12).refine((value) => new Set(value).size === value.length, 'Choose each skill once.');
const offsetSchema = z.number().int().min(-720).max(840);

export const signupSchema = z.object({ email: emailSchema, password: passwordSchema, displayName: displayNameSchema }).strict();
export const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
export const profilePatchSchema = z.object({
  displayName: displayNameSchema.optional(), skills: skillsSchema.optional(), utcOffsetMin: offsetSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Choose at least one field to update.');
export const invitePreferenceSchema = z.object({ openToInvites: z.boolean() }).strict();
const uuidParamSchema = z.string().uuid().transform((value) => value.toLowerCase());
export const hackathonParamsSchema = z.object({ hid: uuidParamSchema }).strict();
export const emptyObjectSchema = z.object({}).strict();
export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export type Registration = { hackathonId: string; openToInvites: boolean; registeredAt: string };
export type Profile = {
  id: string; email: string; displayName: string; skills: Skill[]; utcOffsetMin: number;
  registrations: Registration[];
};
export type Hackathon = {
  id: string; name: string; minTeamSize: number; maxTeamSize: number;
  registration: Registration | null;
};

export const teamParamsSchema = hackathonParamsSchema.extend({ tid: uuidParamSchema }).strict();
export const teamCreateSchema = z.object({
  name: safeText.transform((value) => value.trim()).pipe(z.string().min(2).max(60)),
  description: safeText.transform((value) => value.trim()).pipe(z.string().max(500)).default(''),
  lookingFor: z.array(skillSchema).max(8).refine((value) => new Set(value).size === value.length, 'Choose each skill once.').default([]),
  isOpen: z.boolean().default(true),
}).strict();
export const joinCodeSchema = z.object({
  code: safeText.transform((value) => value.trim().toUpperCase()).pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/, 'Use a 10-character invite code.')),
}).strict();
export type TeamCreate = z.infer<typeof teamCreateSchema>;
export type MyTeam = {
  team: TeamDetail | null;
  pendingRequests: { id: string; teamId: string; teamName: string; message: string; createdAt: string }[];
};
export type CreateTeamResult = { team: TeamDetail };
export type JoinTeamResult = { team: TeamDetail; alreadyMember: boolean };
export type LeaveTeamResult = { left: true; teamDeleted: boolean };

export const teamPatchSchema = z.object({
  name: teamCreateSchema.shape.name.optional(),
  description: safeText.transform((value) => value.trim()).pipe(z.string().max(500)).optional(),
  lookingFor: z.array(skillSchema).max(8).refine((value) => new Set(value).size === value.length, 'Choose each skill once.').optional(),
  isOpen: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Choose at least one field to update.');
export const requestCreateSchema = z.object({
  message: safeText.transform((value) => value.trim()).pipe(z.string().max(300)).default(''),
}).strict();
export const requestParamsSchema = hackathonParamsSchema.extend({ rid: uuidParamSchema }).strict();
export const memberParamsSchema = teamParamsSchema.extend({ uid: uuidParamSchema }).strict();
export const pageQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().int().max(50)).default(30),
  cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type TeamPatch = z.infer<typeof teamPatchSchema>;
export type RequestCreate = z.infer<typeof requestCreateSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type JoinRequest = {
  id: string; teamId: string; userId: string; message: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  createdAt: string; decidedAt: string | null; decidedBy: string | null;
};
export type RequestResult = { request: JoinRequest };
export type InboxRequest = JoinRequest & { applicant: { displayName: string; skills: Skill[]; utcOffsetMin: number } };
export type InviteResult = { inviteCode: string; inviteExpiresAt: string };
export type AuditEntry = {
  id: string; teamId: string; actorId: string | null; targetUserId: string | null;
  action: string; details: Record<string, unknown>; requestId: string | null; createdAt: string;
};
