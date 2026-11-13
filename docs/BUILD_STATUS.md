# TeamForge Build Status

Last updated: 2026-11-13 UTC
Current phase: 0 — passed; stopped at the requested commit boundary
Repository/branch: `team-forge`, `main`
Milestone commit: `chore: establish TeamForge project foundation` (this commit; use `git log -1` for its SHA)

| Phase | Status | Evidence | Remaining blocker |
|---|---|---|---|
| 0 | passed | Command results below; API tests and browser smoke script | None for the native local foundation; Docker validation deferred |
| 1 | not-started | — | Intentional milestone boundary |
| 2 | not-started | — | Phase 1 |
| 3 | not-started | — | Phase 2 |
| 4 | not-started | — | Phase 3 |
| 5 | not-started | — | Phase 4 |
| 6 | not-started | — | Phase 5 |
| 7 | not-started | — | Phase 6 |
| 8 | not-started | — | Phase 7 and hosting access |
| 9 | not-started | — | Phase 8 |
| 10 | not-started | Optional | All required phases |

## Last completed work

- Established npm workspaces in `apps/api`, `apps/web`, `packages/shared`, exact dependency pins and Node 22.19.0 selection.
- Added an Express app factory, environment validation, bounded PostgreSQL pool, liveness/readiness, request IDs, JSON error envelopes and same-origin production SPA serving.
- Added a responsive React shell, Vite development proxy, shared error/health schemas and DTO types, and focused configuration/HTTP checks.
- Prepared separate local development/test PostgreSQL Compose services, Docker/Render configuration, environment examples and reproducible setup documentation.

## Commands actually run

All successful project checks used Node 22.19.0 and npm 10.9.3 on WSL/Linux. Commands ran from the repository root with the nvm Node directory on `PATH`.

| Command | Environment | Actual result | Evidence |
|---|---|---|---|
| `npm ci --cache .cache/npm --fetch-retries=0 --fetch-timeout=15000` | Node 22.19.0; registry access allowed | Passed; 311 packages installed from lockfile | `package-lock.json` |
| `npm run lint` | Local | Passed, no warnings | `eslint.config.mjs` |
| `npm run typecheck` | All three workspaces | Passed | Package TypeScript configurations |
| `npm test` | Local HTTP sockets allowed | 2 files, 9 tests passed | `apps/api/test/app.test.ts`, `apps/api/test/config.test.ts` |
| `npm run build` | Shared → API → web | Passed; web JS 143.36 kB / 46.74 kB gzip | Generated, gitignored `dist` directories |
| Native `initdb`, `pg_ctl`, `createdb` | Separate `.cache/phase0/pg-data`, loopback 54329 | PostgreSQL 16.15 initialized and database created; no existing database touched | Gitignored `.cache/phase0/postgres.log` |
| `npm run db:check` | Native PostgreSQL 16.15 | Passed, `reachable: 1` | `scripts/check-db.mjs` |
| `npm run dev` | API 8080, Vite 5173, shared watcher | Started successfully; development proxy verified | Browser checks below |
| `node scripts/smoke-web.mjs` | Chromium, development URL, 375 and 1280 px | Passed React rendering, keyboard skip link, no overflow, no page exceptions, health, actual DB readiness and JSON API 404s | `scripts/smoke-web.mjs` |
| `node --env-file=.env apps/api/dist/server.js` + browser smoke | Production environment, port 8081, 375 and 1280 px | Passed the same checks through compiled Express static serving; SIGTERM shut down cleanly | Gitignored `.cache/phase0/desktop.png` and `mobile.png`, visually inspected |
| `npm audit --omit=dev --json` | Installed lockfile | Zero production vulnerabilities reported | npm audit result |
| `npm run migrate`, `invariants`, `test:race`, `seed`, `loadtest`, `chaos` | Foundation milestone | Each exited 1 and named its pending phase, as intended | `scripts/pending.mjs` |
| `git check-ignore` and architecture SHA-256 | Repository | Architecture, sidecar and `.env` ignored; architecture content unchanged | `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80` |

Browser checks used the existing Chromium executable via `CHROMIUM_EXECUTABLE_PATH`; they did not require a browser download. Production verification ran with `NODE_ENV=production`, `APP_ORIGIN=https://teamforge.example`, `HOST=127.0.0.1` and `PORT=8081`. This was local verification, not a deployment.

The development/production servers and scratch PostgreSQL instance were stopped after verification. On this workspace, the retained, gitignored native cluster can be restarted without Docker:

```sh
/usr/lib/postgresql/16/bin/pg_ctl -D .cache/phase0/pg-data -l .cache/phase0/postgres.log -o "-h 127.0.0.1 -p 54329 -k $PWD/.cache/phase0/pg-socket" -w start
nvm use
npm run dev
```

This restart command depends on the local verification cluster already existing. Fresh clones should use the README's Compose setup or configure their own PostgreSQL 16 database.

Initial sandboxed npm/network and HTTP/database socket attempts failed and were rerun with permission. Initial checks also found malformed-URL validation escaping the safe config error handler and missing browser globals in ESLint; both were fixed before the passing runs. The production bundle initially included React development code because `.env` set `NODE_ENV=development`; the template now leaves that value to the process environment, and the rebuilt bundle was browser-verified.

## Decisions and deviations

- Stop after Phase 0 at the user's request, even though the local architecture normally asks to continue through phase gates.
- Keep `ARCHITECTURE.md` unchanged and out of all commits; `.gitignore` also excludes its Windows metadata sidecar.
- The shell defaults to Node 20; use the installed Node 22.19.0 from nvm for all project commands.
- Docker is unavailable in this WSL session. Use installed native PostgreSQL 16.15 in a separate scratch cluster for connectivity verification; do not touch another project's database.
- This milestone implements no authentication or domain mutations. Future commands fail explicitly rather than reporting success for unimplemented work.
- Shared profile DTOs must never expose password hashes, including `/me`; the architecture's exception wording must not be implemented literally.
- Zod 4.6.7 and concurrently 9.2.5 were selected after the initial audit identified advisories in the older candidate pins. No high or critical advisories remain. Full audit still reports seven moderate findings through the development-only typescript-eslint/minimatch dependency chain; no forced major override or audit suppression was applied. The selected ESLint 9 release also reports upstream end of support; lint-tool maintenance remains a follow-up.

## Outstanding requirements / external access

- All Phase 1–9 features and evidence remain outstanding, including CI, schema/migrations, authentication, team operations, concurrency, audit, idempotency, SSE, suggestions, complete UI and benchmarks.
- Docker runtime validation and hosted plan/region/account selection remain unverified. See `DEPLOYMENT.md`.

## Next executable step

- Resume with Phase 1 only after the user's next instruction: implement ordered schema/trigger migrations, the transaction runner and error mapping, real PostgreSQL invariant tests and CI. Keep runtime pool size 20 for the required tests. Domain features and authentication remain for later phases.
