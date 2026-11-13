# TeamForge

Team formation for hackathons, built with Node 22, Express 5, PostgreSQL 16, React 18 and TypeScript.

The project foundation and database layer are implemented: npm workspaces, a React shell, API health checks, transactional migrations, PostgreSQL membership safeguards, transaction/retry handling and invariant checks. Authentication, team formation endpoints, the headline concurrency race and deployment are **not implemented yet**. Progress and the next milestone are recorded in [docs/BUILD_STATUS.md](docs/BUILD_STATUS.md).

## Run locally

Use Node **22.19.0** (`nvm use`) and npm 10. Docker Compose is the recommended local database setup; an existing PostgreSQL 16 server also works.

```sh
nvm use
npm ci
cp .env.example .env
docker compose up -d db
npm run db:check
npm run migrate
npm run dev
```

Open **http://localhost:5173**. Vite forwards `/api`, `/health` and `/ready` to Express on port 8080, keeping browser requests on one origin. The API and shared package rebuild when edited. Change `PORT` in `.env` if needed; Vite reads the same setting.

The database binds only to loopback on port **54329**. Local example credentials are disposable development values. The server validates its configuration on startup; never use the example secrets for a hosted service. In WSL, Docker Desktop integration must be enabled for Docker commands to work. Alternatively, point the database URLs in `.env` at a dedicated local PostgreSQL 16 database.

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

`npm test` runs configuration/HTTP tests and real PostgreSQL migration, constraint and transaction tests. It verifies deferred leadership/count checks, overcapacity rejection, rollback, bounded retries, an actual deadlock, timeout handling and post-commit hooks. It does not yet prove the domain API's 50-person last-seat race. Race tests, seeding, load testing and chaos testing still exit nonzero with their planned phase.

`npm run migrate` prefers `DATABASE_URL_DIRECT`, applies all pending migrations in one advisory-locked transaction, and verifies checksums on later runs. Applied SQL files must not be edited; add another numbered migration. Server startup also runs migrations and stops on failure. The API build copies SQL alongside the compiled runner.

`npm run invariants` checks the configured `DATABASE_URL` without changing data; it exits nonzero if any check fails. To scope it: `npm run invariants -- <hackathon-uuid>`. The CI workflow runs the full local gate with PostgreSQL and a pool of 20; its remote execution remains pending until the changes are pushed.

To check the React shell in Chromium while `npm run dev` is running:

```sh
npx playwright install chromium
npm run smoke:web
```

The smoke check exercises mobile/desktop rendering, keyboard navigation, horizontal overflow and same-origin API routing. `CHROMIUM_EXECUTABLE_PATH` can point to an existing compatible Chromium. `BASE_URL` selects another running app.

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
apps/web/          Vite + React shell and CSS modules
packages/shared/  Browser-safe schemas, DTO types, error codes, skill catalogue
scripts/          Connectivity and browser checks; explicit pending commands
docs/             Build status and deployment prerequisites
```

Shared code compiles before its consumers and exports JavaScript from `dist`; browser code must not import API or database modules. Password hashes never belong in response DTOs, including the current user's profile.

`ARCHITECTURE.md` is a local planning reference excluded from Git at the owner's request. Phase 1 is the current review/commit boundary; authentication follows in Phase 2.
