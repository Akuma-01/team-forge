import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../db/errors.js';

const lifetimeSeconds = 7 * 24 * 60 * 60;
export const issuer = 'teamforge';
export const audience = 'teamforge-browser';

export function createSessions(config: Pick<Config, 'JWT_SECRET' | 'NODE_ENV'>) {
  const key = new TextEncoder().encode(config.JWT_SECRET);
  const cookieOptions = { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
  return {
    issue(userId: string) {
      return new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId).setIssuer(issuer).setAudience(audience)
        .setIssuedAt().setExpirationTime('7d').sign(key);
    },
    async read(req: Request) {
      try {
        const cookies = (req.headers.cookie ?? '').split(';').map((item) => item.trim()).filter((item) => item.startsWith('sid='));
        if (cookies.length !== 1) throw new Error('Missing or ambiguous session.');
        const token = cookies[0]!.slice(4);
        if (token.length > 4096) throw new Error('Invalid session.');
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'], issuer, audience, requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '7d',
        });
        const userId = z.string().uuid().parse(payload.sub);
        if (payload.exp! - payload.iat! > lifetimeSeconds) throw new Error('Invalid lifetime.');
        return userId;
      } catch { throw new AppError('UNAUTHENTICATED', 401, 'Please sign in to continue.'); }
    },
    write(res: Response, token: string) { res.cookie('sid', token, { ...cookieOptions, maxAge: lifetimeSeconds * 1000 }); },
    clear(res: Response) { res.clearCookie('sid', cookieOptions); },
  };
}
