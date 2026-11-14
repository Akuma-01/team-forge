# Historical Phase 1 handoff

The user subsequently committed this milestone as `fa7e715` (`feat: add PostgreSQL schema and transaction foundation`). The record below preserves the original verification and handoff state.

# TeamForge Build Status

Last updated: 2026-11-13 UTC
Current phase: 1 — local gate passed; stopped for user review/commit
Repository/branch: `team-forge`, `main`
Base commit: `a2f2995` (`chore: establish TeamForge project foundation`)
Phase 1 changes: uncommitted and unstaged, as requested. No push or remote workflow run.

| Phase | Status | Evidence | Remaining blocker |
|---|---|---|---|
| 0 | passed | [Phase 0 record](PHASE_0.md) | Docker verification still deferred |
| 1 | passed (local) | Commands and tests below | Remote CI unverified until commit/push |
| 2 | not-started | — | User's next milestone instruction |
| 3 | not-started | — | Phase 2 |
| 4 | not-started | — | Phase 3 |
| 5 | not-started | — | Phase 4 |
| 6 | not-started | — | Phase 5 |
| 7 | not-started | — | Phase 6 |
| 8 | not-started | — | Phase 7 and hosting access |
| 9 | not-started | — | Phase 8 |
| 10 | not-started | Optional | All required phases |

## Last completed work

- `apps/api/src/db/migrations/`: specified schema and triggers. Capacity, one membership per hackathon, matching hackathons, membership immutability, deferred leadership/count checks, version updates and append-only audit history are enforced in PostgreSQL. Incomplete teams are allowed.
- `db/migrate.ts`: ordered, checksummed migration history with a transaction-scoped advisory lock. All pending migrations and history commit together. Modified/deleted/reordered history fails. Server startup migrates through the direct database URL when configured.
- `db/tx.ts`, `db/client.ts`, `db/errors.ts`, `db/pool.ts`: one-client READ COMMITTED transactions, bounded acquisition/lock/query/idle waits, rollback/discard/release, three total attempts for 40P01/40001 only, release before backoff, awaited hooks after COMMIT, safe diagnostics and named-constraint error mapping. Swallowed SQL failures cannot produce apparent success.
- `db/invariants.ts` and CLI scripts: B.1–B.8, optional hackathon UUID scope and nonzero failure exit. Read-only diagnostic checks use one consistent snapshot; business transactions remain READ COMMITTED.
- `apps/api/test/`: dedicated database guard, isolated schemas, factories, HTTP helper and explicit coordination signals. Tests cover migrations, constraints, rollback, real deadlocks, retries, timeouts, broken connections, audit and checker scope.
- `.github/workflows/ci.yml`: PostgreSQL 16, pool size 20, install/lint/typecheck/migrate twice/tests/invariants/build. API/Docker builds package SQL migrations. Tool scripts are typechecked.

## Commands actually run

Environment: Node 22.19.0, npm 10.9.3, native PostgreSQL 16.15, WSL/Linux. Database/HTTP socket access was explicitly allowed. No dependency versions or lockfile contents changed.

| Command / check | Actual result | Evidence |
|---|---|---|
| Native `initdb`, `pg_ctl`, `createdb` | Separate scratch instance on loopback 54330 and `teamforge_test` | Gitignored `.cache/phase1/pg-data`, `postgres.log` |
| `npm run lint` | Passed | Root ESLint configuration |
| `npm run typecheck` | Passed for shared, API/tests, web and scripts | Workspace configs and `tsconfig.tools.json` |
| `npm run build` | Passed; both SQL migrations copied into compiled API | `scripts/copy-migrations.mjs`, generated `dist/db/migrations/` |
| `npm test` | **6 files, 55 tests passed, no unhandled errors** | `apps/api/test/{app,config,errors}.test.ts`, `apps/api/test/db/*.test.ts` |
| `npm run migrate` against scratch test DB | Applied `0001_schema.sql`, `0002_triggers.sql` | CLI output |
| Second `npm run migrate` | Applied `[]`; no changes | CLI output |
| `npm run invariants` against scratch test DB | B.1–B.8 all returned zero violations | CLI output and populated-fixture integration tests |
| Compiled production server, local port 8082 | Startup migration replay, readiness, liveness and static HTML passed; SIGTERM passed | Gitignored `.cache/phase1/verify-cli.mjs` |
| `git diff --check` | Passed | Local diff |

The positive CLI check used the empty migrated public schema; integration tests also checked populated valid and deliberately invalid fixtures in temporary schemas. These 55 tests mix unit, HTTP foundation and database cases. They do **not** establish 20 distinct domain API behaviors or the 50-person last-seat race.

Initial checks found a broken-connection bug: pg emits an error event on a checked-out client as well as rejecting its query. The client guard now handles it and discards that connection; backend termination passes without an unhandled exception. One deadlock run ended in lock/statement timeouts. The isolated test now sets a 50 ms deadlock detector interval while preserving the runtime's 2 s lock / 5 s statement timeouts; the final full suite passed. The test role needs permission to set `deadlock_timeout`, as supplied by Docker/CI.

## Decisions and deviations

- Stop at Phase 1. Do not stage, commit or push; the user will commit.
- `ARCHITECTURE.md` is unchanged and ignored. SHA-256: `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80`.
- CI uses the required pool size 20 rather than the illustrative older CI snippet's 50.
- Tests require an explicit `TEST_DATABASE_URL`, loopback host and database name ending in `_test`; query overrides and production mode are refused. Only generated `spec_*` schemas are created/dropped. No global truncation or existing database reset.
- Publication and diagnostic logging failure cannot replay a committed mutation.
- Audit completeness and pending-request cancellation still need later domain services. B.7/B.8 detect their absence; these application operations are not implemented yet.
- Phase 0 dependency audit findings and unavailable Docker environment are unchanged. No dependency upgrade or UI change was needed.

## Outstanding requirements / external access

- Remote GitHub Actions has not run on these uncommitted changes. Local lint/typecheck/tests/migrations/invariants/build passed; no remote CI success claimed.
- Docker build/Compose execution remains unverified because Docker is unavailable. Native PostgreSQL verification is complete.
- Authentication, profiles, registration, domain endpoints, idempotency service, mutation audit production, race suite, SSE, suggestions, complete UI, seed, benchmarks and deployment remain for Phases 2–9.
- No new deployment or performance result claimed.

## Local test database restart

The verification server and scratch database are stopped at handoff. The retained native test cluster is gitignored, and its credentials match `TEST_DATABASE_URL` in `.env.example`. On this workspace:

```sh
/usr/lib/postgresql/16/bin/pg_ctl -D .cache/phase1/pg-data -l .cache/phase1/postgres.log -o "-h 127.0.0.1 -p 54330 -k $PWD/.cache/phase1/pg-socket" -w start
nvm use
npm test
```

Fresh clones should use the README's Compose test service.

## Next executable step

After the user's next instruction, begin Phase 2: auth/session configuration, password hashing, signup/login/logout, profile/registration, Origin validation/rate limiting and the minimal authenticated browser flow. Preserve applied migrations; use a new numbered migration for later schema changes.

Suggested commit message: `feat: add PostgreSQL schema and transaction foundation`
