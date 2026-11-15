# TeamForge

Team formation for hackathons: find complementary skills, apply to teams, or join with a private invite. Leaders review applications and manage membership; everyone sees live updates and explained teammate suggestions.

Built with **Node 22, Express 5, PostgreSQL 16, React 18 and TypeScript**.

## Live Demo

**Application:** https://team-forge-production.up.railway.app/

### Demo Credentials

| Role | Email | Password |
|---|---|---|
| Team Leader | seed_user_00001@teamforge.demo | demo-only-replace-before-seeding |
| Participant | seed_user_05000@teamforge.demo | demo-only-replace-before-seeding |

Use two separate browser sessions to experience the team formation and real-time synchronization flows.

## Run locally

Requires Node **22.19.0**, npm 10 and Docker Compose (or an existing PostgreSQL 16 server).

```sh
nvm use
npm ci
npm run env:setup
docker compose up -d db
npm run db:check
npm run migrate
SEED_DEMO=true npm run seed
npm run dev
```

Open **http://localhost:5173**. Vite forwards API requests to Express on port 8080. The development database listens on loopback port **54329**. For an existing PostgreSQL server, set `DATABASE_URL` and `DATABASE_URL_DIRECT` in `.env` before migrating.

`env:setup` creates a private, ignored `.env` with a random JWT secret. The seed command is for an explicitly selected demo database: it creates **10,000 participants, 2,000 teams and 4,900 memberships**. Repeat runs preserve existing rows and refuse a changed baseline.

For the seeded local demo, sign in as:

- **Email:** `seed_user_05000@teamforge.demo`
- **Password:** `demo-only-replace-before-seeding`

These are demo credentials only. The password can be overridden using `SEED_PASSWORD` when first seeding. To start empty, omit seeding and create a development hackathon using the SQL in the [testing guide](docs/TESTING.md#manual-demo).

## Try the main flow

1. Sign up and register for the hackathon, or use a seeded account.
2. Search teams by name or needed skill and apply to one with room.
3. Use a second browser session as the leader to accept the application. Both views update automatically.
4. Try invite sharing, code rotation, removal and leaving. Leaving as leader transfers ownership; the last member's departure deletes the team.

Members can inspect suggested teammates, scoring explanations and team activity. A private invite can join a closed team while seats remain available.

## Design

- **PostgreSQL owns correctness.** Explicit locks serialize competing membership changes; constraints and triggers enforce capacity, one team per participant and valid leadership. Minimum size determines readiness, not whether a team can exist.
- **Retries preserve one effect.** A successful mutation, audit record and idempotent response commit together. The browser reuses its key when a response is lost.
- **Discovery stays inexpensive.** Keyset pagination, a partial board index and a bounded one-second cache serve open teams. Joins always recheck capacity inside a transaction.
- **Live events trigger authorized reads.** SSE carries public invalidations, not private team data. Reconnect, focus and periodic refresh recover missed events.
- **Sessions stay server-verified.** Argon2id passwords, HttpOnly cookies, origin checks and role-scoped responses protect account and leader actions.

The API, web UI and shared contracts live in `apps/api`, `apps/web` and `packages/shared`.

See the [API and behavior reference](docs/API.md) for endpoints, permissions and retry semantics.

## Verification and results

| Check | What it establishes |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run build` | Static checks and production compilation |
| `npm test` and `npm run test:race` | API/database correctness and concurrent membership changes |
| `npm run smoke:workspace` | Main browser acceptance flow: discovery, applications, leader controls and permission changes at mobile and desktop widths |
| `npm run test:a11y` | Automated accessibility checks and keyboard traversal |

Start the dedicated test database with:

```sh
docker compose --profile test up -d db-test
```

Browser checks also need:

```sh
npx playwright install chromium
```

Run `npm run build` before the smoke scripts. These checks create their own temporary schemas and servers.

Full setup, coverage and evidence locations are in [Testing](docs/TESTING.md).

**Recorded local results:** lint, typecheck, build and **10 targeted hardening regressions passed**. Earlier concurrency verification passed **56 tests**, including twenty repetitions of the 50-user last-seat race.

The complete regression and race suites still need a fresh run after the hardening changes.

Historical load measurements and the outstanding stable-clock benchmark are summarized in the [one-page performance report](loadtest/REPORT.md).

Use `smoke:auth`, `smoke:teams` and `smoke:live` for focused identity, keyboard lifecycle and live-recovery checks; they also form part of the CI browser gate.

`smoke:web` checks an already-running development app. `verify-production-readiness.ts` is an optional local production-configuration diagnostic, not evidence of a live deployment.

See the [script guide](docs/TESTING.md#browser-and-runtime-checks) for when each matters.

## Deployment and limits

`npm run build` produces the web bundle and API; `npm start` runs Express.

Production requires:

- `NODE_ENV=production`
- An HTTPS `APP_ORIGIN`
- Database URLs
- Fresh production secrets

Express serves the UI and API from one origin and applies migrations on startup.

- `/health` checks the process.
- `/ready` checks PostgreSQL.

Follow [Deployment](docs/DEPLOYMENT.md) for hosting and restricted database-role setup.

The cache, rate limits and SSE hub assume **one app instance**.

Known limitations:

- Logout clears the cookie but does not revoke a copied token.
- Password reset is not implemented.
- Email verification is not implemented.
- The optional chaos runner is not implemented.
- No deployed performance result is claimed.

Hosted deployment and hosted smoke results remain unverified.

---

**Project:** TeamForge  
**Stack:** Node.js · Express · PostgreSQL · React · TypeScript
