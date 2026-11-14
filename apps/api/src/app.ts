import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import type { ApiError, ErrorCode, Health } from '@teamforge/shared';
import { AppError } from './db/errors.js';
import { identityRouter } from './modules/auth/routes.js';
import type { IdentityOptions } from './modules/auth/routes.js';
import { requireOrigin } from './middleware/origin.js';

type AppOptions = {
  checkDatabase: () => Promise<void>;
  production?: boolean;
  webDirectory?: string;
  identity?: IdentityOptions;
};

function sendError(res: express.Response, status: number, code: ErrorCode, message: string, details?: AppError['details']) {
  const body: ApiError = { error: { code, message, requestId: String(res.getHeader('X-Request-Id')), ...(details ? { details } : {}) } };
  res.status(status).json(body);
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.identity?.config.TRUSTED_PROXY_CIDRS.length ? options.identity.config.TRUSTED_PROXY_CIDRS : false);
  app.use((_req, res, next) => {
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': options.production ? [] : null,
      },
    },
    strictTransportSecurity: options.production ?? false,
  }));
  if (options.identity) app.use('/api', requireOrigin(options.identity.config.APP_ORIGIN));
  app.use(express.json({ limit: '10kb', strict: true }));

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' } satisfies Health);
  });
  app.get('/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await options.checkDatabase();
      res.json({ status: 'ok' } satisfies Health);
    } catch {
      res.setHeader('Retry-After', '1');
      sendError(res, 503, 'BUSY', 'The database is temporarily unavailable.');
    }
  });

  // Future API routes are mounted above this boundary. Never send SPA HTML for an API miss.
  if (options.identity) app.use('/api', identityRouter(options.identity));
  app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Resource not found.'));
  app.use(['/health', '/ready', '/metrics'], (_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Resource not found.');
  });

  if (options.webDirectory) {
    const webDirectory = options.webDirectory;
    app.use(express.static(webDirectory, { index: false }));
    app.get('/{*path}', (req, res, next) => {
      if (!req.accepts('html') || req.path.split('/').some((segment) => segment.includes('.')) || req.path.startsWith('/assets/')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDirectory, 'index.html'));
    });
  }

  app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Resource not found.'));
  const errorHandler: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { _next(error); return; }
    if (error instanceof AppError) {
      if (error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
      sendError(res, error.status, error.code, error.message, error.details);
      return;
    }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    if (type === 'entity.parse.failed') {
      sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
    } else if (type === 'entity.too.large') {
      sendError(res, 413, 'VALIDATION_ERROR', 'Request body exceeds 10 kB.');
    } else {
      console.error(JSON.stringify({ event: 'request.failed', requestId: res.getHeader('X-Request-Id') }));
      sendError(res, 500, 'INTERNAL', 'An unexpected error occurred.');
    }
  };
  app.use(errorHandler);
  return app;
}
