# Testing and verification

[Project overview](../README.md) · [API reference](API.md) · [Performance summary](../loadtest/REPORT.md)

## Test environment

Use Node 22.19.0 and a dedicated PostgreSQL 16 database:

```sh
nvm use
npm ci
npm run env:setup
docker compose --profile test up -d db-test
npm run build
```

`TEST_DATABASE_URL` must identify a loopback database whose name ends in `_test`; production mode and arbitrary URL overrides are refused. A single absolute Unix-socket `host` override is supported. The Compose test database listens on port **54330**, separate from development on **54329**. Each database suite creates, migrates and drops its own schema without truncating existing schemas.

Deadlock tests need permission to set `deadlock_timeout`; audit-permission tests create and remove a temporary runtime role. Use the supplied disposable test service or an equivalently privileged dedicated test instance, never a production database.

## Main verification gate

```sh
npm run lint
npm run typecheck
npm test
npm run test:race
npm run build
npx playwright install chromium
npm run smoke:workspace
npm run test:a11y
```

`npm test` covers shared validation, configuration, authentication, independent rate limits, hackathon isolation, applications, leadership controls and real PostgreSQL migrations, constraints and transaction behavior. Cases include duplicate intents, rollback, expiry during a lock wait, pending-request limits, failed acceptance, removal and retained idempotent responses.

The tooling regressions cover guarded seeding, preservation of real activity on refusal, token lifetime/permissions, propagation of a failed k6 process and cleanup of owned servers. A deliberately failing executable is used only to test runner failure handling; it is not a throughput measurement.

## Concurrency and invariants

`npm run test:race` repeats a 50-user last-seat HTTP race **20 times**. Each repetition requires exactly one success, forty-nine `TEAM_FULL` conflicts, the expected final members and no invariant violations. Other races exercise both lock orders for accepts, code joins, removal, leaving, invite rotation, leadership transfer and competing request decisions.

The application uses a 20-connection pool with normal authentication, rate limits and database timeouts. Barriers verify actual PostgreSQL blocking with `pg_blocking_pids`. A separate API test checks 50 participants sharing one IP; success and capacity conflicts do not consume the invalid-code failure budget. The cleanup regression ensures rejected user quotas do not leak shared IP slots.

Database invariants cover member counts, capacity, nonempty teams, leader membership, one team per participant, hackathon scope, pending-request cancellation and audit coverage. Check a configured database without changing it:

```sh
npm run invariants
npm run invariants -- <hackathon-uuid>
```

The release-race artifact is `.cache/phase4/last-seat.json`; CI uploads it. It includes outcomes, invariant counts, pool usage and clock observations.

## Browser and runtime checks

Browser acceptance scripts start their own servers and isolated test schemas. Install Chromium once with `npx playwright install chromium`; `CHROMIUM_EXECUTABLE_PATH` can select an existing compatible browser, and Playwright supports `PLAYWRIGHT_BROWSERS_PATH` for its browser cache.

| Command/script | Use it for | Evidence |
|---|---|---|
| `npm run smoke:workspace` | Primary UI acceptance: board filters/history/pagination, applications, decisions, capacity conflicts, edits, invite expiry/rotation, removal, suggestions, activity and permission changes | `.cache/phase7/` screenshots and `browser.json` |
| `npm run smoke:auth` | Signup/onboarding, profile persistence, registration/preferences, logout/login, expiry and account isolation | `.cache/phase2/` screenshots |
| `npm run smoke:teams` | Full Tab-driven signup/register/create/copy/join/leave flow, lost-response replay, promotion and deletion | `.cache/phase3/` screenshots |
| `npm run smoke:live` | Multi-session reconciliation, a change during an initial fetch, dropped notifications, focus/reconnect, role revocation and logout | Command output |
| `npm run test:a11y` | Axe WCAG 2.1 A/AA checks and keyboard traversal across core views and dialogs; builds first | Command output |
| `npm run smoke:web` | Lightweight routing, keyboard, health/readiness check against an already-running development app; accepts `BASE_URL` | Command output |
| `scripts/verify-production-readiness.ts` | Optional local check of production static serving, startup migrations, origin enforcement, secure-cookie attributes and shutdown | Command output; not a hosted smoke test |

Identity, lifecycle and workspace acceptance scripts exercise **375px and 1280px** viewports. The workspace script also checks 320px overflow, 44px targets, focus behavior and reduced-motion layouts. It uses three sessions and real API/SQL calls. Only the negative read-recovery case injects a 503; no successful business operation is mocked. The live script waits for the normal **30-second** visible-page reconciliation interval in its missed-event case.

The production-readiness diagnostic uses the configured database, creates a test signup and binds local port 8085. Run it only against a dedicated demo/test database after building:

```sh
node --env-file-if-exists=.env --import tsx scripts/verify-production-readiness.ts
```

Its HTTPS origin is a test configuration value, not an existing deployment URL. Actual hosted acceptance follows the [deployment checklist](DEPLOYMENT.md).

## Performance checks

Use a separately selected demo database with the documented dataset. Seeding requires explicit acknowledgement, preserves existing activity and refuses a changed baseline:

```sh
npm run migrate
SEED_DEMO=true npm run seed
npm run build
npm run test:perf-ci
npm run loadtest -- realistic
npm run loadtest -- stress
```

k6 must be on PATH, at `loadtest/bin/k6`, or selected with `K6_BIN`. The **CI smoke** runs 10 VUs for 20 seconds with p95 below 500 ms and errors below 1%. It is a quick regression gate, not the **100-VU full benchmark**, whose target is success-only HTTP p95 below 200 ms and errors below 1%.

The full runner saves independent artifacts under `loadtest/runs/<run-id>/`: raw samples, summaries, clock diagnostics, invariant checks and metadata recording revision, dirty working tree, dataset, environment and settings. It fails on failed k6 thresholds or invalid timing evidence. Tokens in `loadtest/tokens.json` are private, two-hour credentials; never commit or upload them. See the [performance summary](../loadtest/REPORT.md) and [captured query plans](../loadtest/QUERY_PLANS.md).

## Recorded results and limitations

The latest hardening review passed lint, typecheck, build and **10 targeted regressions**. Earlier release testing passed **56 concurrency cases**, including all 20 last-seat repetitions. A complete regression/race run, accessibility smoke and full performance rerun after the hardening changes remain outstanding; earlier passes do not certify that revised code.

Local WSL clock jumps caused intermittent expiry, fresh-session and database-timeout failures. A probe recorded a 10.75-second backward step. These failures remain failed checks: do not change assertions, extend runtime timeouts or substitute another latency metric to turn them into passes. Re-run the affected gates on a stable-clock host. The CI configuration is not evidence of a completed remote run.

The workflow runs static, API, race and browser gates; its separate `perf-smoke` job seeds a disposable database and runs the short k6 check. Local scripts and raw artifacts are not a substitute for hosted verification. `npm run chaos` remains an explicit unimplemented optional command.

## Manual demo

For a small empty development database, omit the large seed and create one hackathon with your PostgreSQL client:

```sql
INSERT INTO hackathons (name, min_team_size, max_team_size)
VALUES ('Local builders weekend', 2, 4);
```

Sign up, complete onboarding and register. Use a second account in a private window to exercise invite joining or application acceptance. Check both sessions after removal, leadership transfer and the last member leaving.
