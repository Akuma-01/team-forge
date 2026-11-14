import type { RequestHandler } from 'express';
import { AppError } from '../db/errors.js';

export function requireOrigin(origin: string): RequestHandler {
  return (req, _res, next) => {
    if (req.originalUrl.length > 2048) throw new AppError('VALIDATION_ERROR', 400, 'Request URL is too long.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('Origin') !== origin) throw new AppError('FORBIDDEN', 403, 'Request origin is not allowed.');
      const hasBody = Number(req.get('Content-Length') ?? 0) > 0 || req.get('Transfer-Encoding') !== undefined;
      if (hasBody && !req.is('application/json')) throw new AppError('VALIDATION_ERROR', 400, 'Use a JSON request body.');
    }
    next();
  };
}
