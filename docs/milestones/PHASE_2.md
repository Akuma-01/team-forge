# Historical Phase 2 handoff

The user committed this milestone as `846ea99` (`feat: add authentication and participant onboarding`). The record below preserves its original verification and handoff state.

# TeamForge Build Status

Last updated: 2026-11-13 UTC
Current phase: 2 — local functional gate passed; stopped for user review/commit
Repository/branch: `team-forge`, `main`
Base commit: `fa7e715` (`feat: add PostgreSQL schema and transaction foundation`)
Phase 2 changes: uncommitted and unstaged, as requested. No push or remote workflow run.

| Phase | Status | Evidence | Remaining blocker |
|---|---|---|---|
| 0 | passed | [Phase 0 record](PHASE_0.md), commit `a2f2995` | Docker verification deferred |
| 1 | passed (local) | [Phase 1 record](PHASE_1.md), commit `fa7e715` | Remote CI unverified |
| 2 | passed (local) | HTTP/browser gate below | Dependency findings remain open; remote CI unverified |
| 3 | not-started | — | User's next milestone instruction |
| 4 | not-started | — | Phase 3 |
| 5 | not-started | — | Phase 4 |
| 6 | not-started | — | Phase 5 |
| 7 | not-started | — | Phase 6 |
| 8 | not-started | — | Phase 7 and hosting access |
| 9 | not-started | — | Phase 8 |
| 10 | not-started | Optional | All required phases |

## Completed work and changed paths

- `apps/api/src/modules/auth/`: signup/login/logout, Argon2id hashing, generic login failures with dummy verification for unknown accounts, HS256-only JWT verification, seven-day sessions, explicit safe profile DTOs, own-profile updates. Cookies are HttpOnly/SameSite=Lax/Path=/ and Secure in production. Tokens require subject, issued-at, expiry, issuer and audience; the subject must identify an existing user.
- `apps/api/src/modules/hackathons/`: authenticated list/detail, natural idempotent registration, own invite preference. Twenty simultaneous registrations produce one participant row and the same registration response. No new migration or change to applied migrations.
- `apps/api/src/middleware/`, `app.ts`, `config.ts`, `server.ts`, `db/errors.ts`: strict Origin/JSON/URL boundaries, field validation errors, bounded in-process sliding-window limits, required JWT secret, explicit proxy allowlist. Responses carry request IDs; logs and DTOs exclude credentials.
- `packages/shared/src/index.ts`: strict signup/login/profile/registration contracts and browser-safe DTO types. Names/email are normalized, controls rejected before trimming, skills checked against the catalogue, offsets bounded. Unknown identity and privilege fields fail validation.
- `apps/web/src/`: real login/signup, protected onboarding/profile/workspace routes, session and hackathon queries, same-origin API client, account cache clearing, labelled forms and errors, loading/empty/error states, responsive CSS Modules. Profile mutation results cannot restore a previous account's cached identity after logout.
- `scripts/setup-env.mjs`, `.env.example`: generates a private local environment file with a random JWT secret while preserving existing configuration and non-placeholder secrets.
- `apps/api/test/api/auth.test.ts`, `rateLimit.test.ts`, expanded `config.test.ts`, `packages/shared/test/identity.test.ts`: 25 new cases, with real HTTP/PostgreSQL coverage, independent limiter tests and shared validation.
- `scripts/smoke-auth.ts`: repeatable browser journey against the actual app and an isolated test schema. Covers both 375px and 1280px, keyboard form validation/onboarding controls, saved profile/skills/offset, registration/preference, logout/login, live-page session expiry and switching accounts. It cleans up the schema, server and browser. `smoke-web.mjs` now targets the login page.
- Workspace manifests/lockfile, ESLint script coverage, README/deployment notes and `.github/workflows/ci.yml`: dependencies, setup, browser command and CI browser gate. Phase 1's verification record is archived.

## Commands actually run

Environment: Node 22.19.0, npm 10.9.3, native PostgreSQL 16.15, WSL/Linux. Database/server/browser socket access was explicitly allowed. Dependencies pinned: `@node-rs/argon2@2.2.2`, `jose@6.2.17`, `@tanstack/react-query@5.107.1`, `react-router-dom@6.30.6`.

| Command / check | Actual result |
|---|---|
| `npm install`, then `npm ci --cache .cache/npm --fetch-retries=0 --fetch-timeout=15000` | Passed; clean lockfile install. Audit warnings below. |
| `npm run env:setup` | Generated a secret in ignored local `.env`; no secret printed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for shared, API/tests, web and scripts |
| `npm test` | **9 files, 80 tests passed**, no unhandled errors |
| `npm run build` | Passed; compiled API/migrations and Vite client |
| `CHROMIUM_EXECUTABLE_PATH=<installed Chromium> npm run smoke:auth` | Passed at **375px and 1280px**, no page exceptions or horizontal overflow |
| Screenshot review | Login and onboarding reviewed; evidence retained in ignored `.cache/phase2/` |
| `node .cache/phase1/verify-cli.mjs` | Reused local verifier against dedicated test DB: migrate twice, invariants, compiled production startup/readiness/liveness/static HTML, SIGTERM all passed |
| `npm run migrate` twice via verifier | Applied `[]` both times; existing migrations unchanged |
| `npm run invariants` via verifier | B.1–B.8 returned zero violations on migrated public test schema |
| `npm audit --omit=dev --json` | Nonzero: **2 moderate affected packages** in Router chain, detailed below |
| `git diff --check`, ignored architecture hash, empty Git index | Passed; architecture unchanged |

The HTTP tests exercise invalid/expired/wrong-algorithm tokens, cookie flags, generic login failures, exact-origin enforcement, control/unknown-field rejection, JSON/URL limits, user isolation and concurrent registration. Rate tests separately cover 20 signup attempts/hour, 10 failed logins/15 minutes, successful-login refunds, concurrent failures, normalized-email limits across trusted proxy IPs, forged forwarding headers with default trust disabled, 60 mutations/user/minute, 600 reads/user/minute, sliding expiration and bounded memory.

The native Argon2 package's ambient const enum conflicted with TypeScript's `verbatimModuleSyntax`; the code uses its documented Argon2id numeric value, and the HTTP test verifies the stored algorithm and cost parameters. An extended browser expiry check initially dispatched a synthetic visibility event on the wrong target and timed out; it now targets the listener on `window`, has explicit timeouts and passes while the existing page/cache stays mounted. No application checks were bypassed.

These tests do **not** establish the 50-person last-seat race or the full team formation acceptance criteria. Registration idempotency does not implement the Phase 3 idempotency-key service.

## Dependency findings and exposure assessment

The full clean install reports **9 moderate affected packages**; 7 are the existing development-tool findings from Phase 0. Production audit reports 2 packages (`react-router` and its dependent `react-router-dom`) from two remaining advisories. No high/critical findings were reported.

The initial Router 6.30.3 install was patched to **6.30.6**, resolving the fixes available on the prescribed Router 6 line. The remaining upstream fixes require Router 7.18 or later:

- [Untrusted navigation paths](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6). Code review finds that all current links/redirect destinations are fixed application paths; user names, URL parameters and server responses never supply navigation targets. The assessment that the current routes do not expose the described attack is an inference from these call sites, not a clean audit result. Review this again before adding return-to parameters or externally supplied navigation.
- [SSR hydration constructor injection](https://github.com/remix-run/react-router/security/advisories/GHSA-337j-9hxr-rhxg). The maintainer excludes declarative mode. This application uses `BrowserRouter` and client rendering, without SSR/hydration.

Keep the architecture's Router 6 for this milestone and retain these findings visibly. A later dependency review should evaluate Router 7 and the existing development-tool findings before deployment. No audit-clean or deployment-ready claim is made.

## Decisions, limitations and remaining gaps

- Stop at Phase 2. Do not stage, commit or push. Suggested commit: `feat: add authentication and participant onboarding`.
- `ARCHITECTURE.md` remains ignored and unchanged. SHA-256: `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80`.
- Password hashes never appear in responses, including `/me`. Only the caller's `/me` returns email. Organizers cannot self-assign privileges.
- Logout clears the browser cookie; separately retained valid JWTs remain usable until expiry. No email verification/password reset or server-side revocation was added.
- Login applies separate IP and normalized-email failure caps. In-flight reservations prevent a parallel batch from exceeding the cap; successful attempts refund their own entries without deleting prior failures.
- Limits remain in-process, per app instance. Trusted proxies default to none; the exact allowlist/topology must be verified at deployment.
- Browser tests create real users/events only inside disposable schemas. Fresh development databases show an honest empty hackathon list; the README includes optional local fixture SQL. Bulk demo seeding remains Phase 8.
- Remote CI, Docker/Compose runtime and hosted deployment were not executed. CI now includes Chromium installation and `smoke:auth`, but no remote success is claimed.
- Team creation/joining, idempotency keys, audit production, headline race tests, SSE, suggestions, full team UI, benchmarks and deployment remain for later milestones.

## Handoff and next step

The owned verification servers and native test database are stopped at handoff. The scratch cluster and screenshots remain gitignored. To restart the local test cluster on this workspace:

```sh
/usr/lib/postgresql/16/bin/pg_ctl -D .cache/phase1/pg-data -l .cache/phase1/postgres.log -o "-h 127.0.0.1 -p 54330 -k $PWD/.cache/phase1/pg-socket" -w start
nvm use
npm test
npm run build
CHROMIUM_EXECUTABLE_PATH=/home/akuma/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run smoke:auth
```

Fresh clones should use the README's Compose test service.

After the user's next milestone instruction, begin **Phase 3: the core team lifecycle** — idempotency keys, creation, code joining, leaving, leader promotion, last-member deletion, transactional audit records and the basic browser screens. Use the existing transaction/lock discipline, registration identity and strict validation. Preserve applied migrations; use a new numbered migration for any schema changes.
