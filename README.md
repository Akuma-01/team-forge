# TeamForge

Team formation for hackathons, built with Node 22, Express 5, PostgreSQL 16, React 18 and TypeScript.

The foundation, database layer and identity flow are implemented. You can create an account, sign in, edit your skills and UTC offset, register for a hackathon, and choose whether you are open to teammate suggestions. PostgreSQL membership safeguards, transaction/retry handling and invariant checks are ready for the next milestone. Team formation endpoints, the headline concurrency race and deployment are **not implemented yet**. Progress is recorded in [docs/BUILD_STATUS.md](docs/BUILD_STATUS.md).

## Run locally

Use Node **22.19.0** (`nvm use`) and npm 10. Docker Compose is the recommended local database setup; an existing PostgreSQL 16 server also works.

```sh
nvm use
npm ci
npm run env:setup
docker compose up -d db
npm run db:check
npm run migrate
npm run dev
```

Open **http://localhost:5173**. Vite forwards `/api`, `/health` and `/ready` to Express on port 8080, keeping browser requests on one origin. The API and shared package rebuild when edited. Change `PORT` in `.env` if needed; Vite reads the same setting.

The database binds only to loopback on port **54329**. Local example credentials are disposable development values. `env:setup` creates a private, gitignored `.env` with a random 32-byte JWT secret; existing non-placeholder secrets and other settings are preserved. Startup refuses missing/short/placeholder secrets. Use fresh secrets for a hosted service. In WSL, Docker Desktop integration must be enabled for Docker commands to work. Alternatively, point the database URLs in `.env` at a dedicated local PostgreSQL 16 database.

Sign up at `/signup`, complete `/onboarding`, and revisit `/profile` to make changes. A fresh database has no hackathons: the UI shows an empty state, and the full demo seed is scheduled for Phase 8. To review registration manually, run this SQL in your **development** database using your PostgreSQL client:

```sql
INSERT INTO hackathons (name, min_team_size, max_team_size)
VALUES ('Local builders weekend', 2, 4);
```

```sh
docker compose --profile test up -d db-test
```

The test database has its own port **54330**, database name and temporary storage. `npm test` requires `TEST_DATABASE_URL` pointing to a loopback PostgreSQL database whose name ends in `_test`. It refuses production mode and URL query overrides. Each database suite creates/migrates its own temporary schema and drops that schema afterward; existing schemas and data are not reset. The deadlock test uses the supplied test role's permission to set `deadlock_timeout` locally.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run db:check
```

`npm test` runs shared validation, configuration, authentication/profile/registration HTTP tests, independent rate-limit tests, and real PostgreSQL migration, constraint and transaction tests. It covers expired/invalid sessions, local/production cookie flags, Origin enforcement, profile isolation, rejected privilege fields, forged forwarding headers and concurrent idempotent registration. The database tests cover deferred leadership/count checks, rollback, retries, a real deadlock and post-commit hooks. These do not yet prove the domain API's 50-person last-seat race. Race tests, seeding, load testing and chaos testing still exit nonzero with their planned phase.

`npm run migrate` prefers `DATABASE_URL_DIRECT`, applies all pending migrations in one advisory-locked transaction, and verifies checksums on later runs. Applied SQL files must not be edited; add another numbered migration. Server startup also runs migrations and stops on failure. The API build copies SQL alongside the compiled runner.

`npm run invariants` checks the configured `DATABASE_URL` without changing data; it exits nonzero if any check fails. To scope it: `npm run invariants -- <hackathon-uuid>`. The CI workflow runs the full local gate with PostgreSQL and a pool of 20; its remote execution remains pending until the changes are pushed.

To verify the complete identity flow in Chromium:

```sh
npx playwright install chromium
npm run build
npm run smoke:auth
```

`smoke:auth` needs the local test database. It starts its own server, creates a temporary schema and real hackathon fixture, and checks signup, keyboard onboarding, profile persistence, registration/preference, logout/login, expiry and account isolation at 375px and 1280px. It removes its schema and closes the server/browser afterward. Screenshots are written to gitignored `.cache/phase2/`. `CHROMIUM_EXECUTABLE_PATH` can point to an existing compatible Chromium. The lighter `smoke:web` still checks rendering, keyboard access, health/readiness and API routing against a running dev app; `BASE_URL` overrides its default URL.

## Identity and request boundaries

Passwords use Argon2id. Sessions use a seven-day HS256 JWT in the `sid` cookie, with HttpOnly, SameSite=Lax and Path=/; Secure is enabled in production. Tokens are never stored in browser storage. Logout clears the browser cookie; it does **not** revoke an independently retained token. Email verification and password reset remain outside the planned scope.

Unsafe `/api` methods require an `Origin` exactly matching `APP_ORIGIN`, including requests from HTTP test clients. Bodies must be JSON where present and are capped at 10 kB. Unknown fields are rejected, and only `/me` returns the caller's email; password hashes never leave the API. Self-assignment of organizer status is prohibited.

Limits are in-process and require one app instance: signup 20 attempts/IP/hour, login 10 failures/15 minutes independently per IP and normalized email, authenticated mutations 60/user/minute and reads 600/user/minute. In-flight logins reserve quota; successful attempts refund only their own reservation. A 429 includes `Retry-After`. `TRUSTED_PROXY_CIDRS` defaults to empty (forwarded addresses ignored); configure only the verified proxy addresses/CIDRs at deployment.

## Production build

```sh
npm run build
NODE_ENV=production HOST=0.0.0.0 APP_ORIGIN=https://your-host.example npm start
```

Express serves `apps/web/dist` and the API from one process. `APP_ORIGIN` must be an HTTPS origin in production. `/health` checks process liveness without querying PostgreSQL; `/ready` queries the database and returns 503 if it cannot be reached. Configuration and database failures do not print connection strings.

`Dockerfile` and `render.yaml` prepare the later deployment milestone. Docker image building and hosted deployment still need verification; no service, live URL, benchmark or remote CI result is claimed. Current hosting prerequisites are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```text
apps/api/          Express app factory, server, configuration, PostgreSQL pool
apps/web/          React auth/onboarding/profile, session queries and CSS modules
packages/shared/  Browser-safe schemas, DTO types, error codes, skill catalogue
scripts/          Connectivity and browser checks; explicit pending commands
docs/             Build status and deployment prerequisites
```

Shared code compiles before its consumers and exports JavaScript from `dist`; browser code must not import API or database modules. Password hashes never belong in response DTOs, including the current user's profile.

`ARCHITECTURE.md` is a local planning reference excluded from Git at the owner's request. Phase 2 is the current review/commit boundary; team creation and code joining follow in Phase 3. Dependency audit findings and unverified deployment checks are recorded in [docs/BUILD_STATUS.md](docs/BUILD_STATUS.md).
