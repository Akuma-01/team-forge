# Phase 3 — Idempotent team lifecycle

Last updated: 2026-11-14 UTC
Archived phase: 3 — local gate passed; subsequently committed by the user
Repository/branch: `team-forge`, `main`
Base commit: `846ea99` (`feat: add authentication and participant onboarding`)
Phase 3 commit: `f2dec78` (`feat: add idempotent team lifecycle`). No remote workflow result was verified. The original handoff below is retained as historical evidence.

| Phase | Status | Evidence | Remaining blocker |
|---|---|---|---|
| 0 | passed | [Phase 0 record](PHASE_0.md), `a2f2995` | Docker verification deferred |
| 1 | passed (local) | [Phase 1 record](PHASE_1.md), `fa7e715` | Remote CI unverified |
| 2 | passed (local) | [Phase 2 record](PHASE_2.md), `846ea99` | Previously documented dependency findings |
| 3 | passed (local) | Gate and commands below | Remote CI unverified |
| 4 | not-started | — | User's next milestone instruction |
| 5 | not-started | — | Phase 4 |
| 6 | not-started | — | Phase 5 |
| 7 | not-started | — | Phase 6 |
| 8 | not-started | — | Phase 7 and hosting access |
| 9 | not-started | — | Phase 8 |
| 10 | not-started | Optional | All required phases |

## Completed work and changed paths

- `apps/api/src/db/idempotency.ts`: UUID request keys scoped to user, recursively canonical JSON fingerprints including method/path, same-transaction response storage, 2xx-only replay, mismatch rejection, bounded reacquisition after cleanup races. HTTP success follows COMMIT. Hourly cleanup deletes up to 500 successful rows older than 24 hours using `FOR UPDATE SKIP LOCKED`; recent/incomplete/locked rows are preserved.
- `apps/api/src/modules/teams/{routes,service,invite}.ts`: authenticated participant-only my-team/detail, creation, code joining and leaving. Mutations lock the participant before the team, use one client and write audit records transactionally. Capacity/count safeguards remain in PostgreSQL. Code validity is checked in a new statement after the team lock returns.
- Creation snapshots hackathon size rules, generates a 50-bit code with up to five collision attempts, inserts the leader membership and `team.created` targeting the creator. Creation/joining cancel pending requests with audit, without locking another team.
- Leaving audits the departure, promotes the earliest-joined remaining user (UUID tie-break), or deletes an empty team and audits the deletion. History survives deletion. Team detail uses one SQL snapshot; invite fields are selected only for the current leader. Passwords/email never enter team DTOs.
- `modules/auth/routes.ts`, auth/hackathon services: profile, registration and preference mutations also accept the idempotency contract. Login/signup/logout stay outside it. Services accept the transaction client instead of nesting transactions or reading through the pool during mutation work.
- `config.ts`, `server.ts`, `db/tx.ts`: bounded invite TTL with default 48 hours; owned retention timer stops before pool shutdown; safe SQLSTATE diagnostics now include infrastructure failures mapped to 503. Failed-code limits are 10/user and 40/IP per 15 minutes, with in-flight reservations and refunds for non-code failures.
- `modules/auth/session.ts`: issue and expiry claims derive from one captured timestamp, preventing a second-boundary lifetime mismatch. Strict algorithm, subject, issuer, audience, future-token and expiry checks remain enabled.
- `packages/shared/src/index.ts`: strict team/create/code/UUID schemas and my-team/create/join/leave DTO types.
- `apps/web/src/features/team/TeamPage.tsx`, routes/styles: real create/join/my-team/detail/leave screens, hackathon selection, current-leader code display/copy, member list/readiness, native leave confirmation with focus restoration, errors and pending states. Existing workspace cards and account navigation link to the team screens.
- `apps/web/src/api/{client,useIntentRequest}.ts`, profile/hackathon forms: stable key per intent, in-flight request deduplication, one retry for network failure/503 with the same key, key retention for a manual retry after an uncertain result, and account checks before retries. Queries are invalidated after confirmed changes; SSE is not yet implemented.
- Tests: `api/teams.test.ts` (18 cases), `db/idempotency.test.ts` (5), `session.test.ts` (1), and an invite-TTL config case: **25 added tests**.
- `scripts/smoke-teams.ts`, package/ESLint scripts, CI, README and deployment notes: repeatable two-account browser journey, including a lost committed response. Phase 2's handoff is archived. Dependencies and lockfile are unchanged; applied migrations are unchanged.

## Commands actually run

Environment: Node 22.19.0, npm 10.9.3, native PostgreSQL 16.15, WSL/Linux, pool size 20. Socket access was explicitly allowed. No dependency installation or audit rerun was needed for this milestone.

| Command / check | Actual result |
|---|---|
| Native `pg_ctl` start | Restarted the retained dedicated test cluster on loopback 54330 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for shared, API/tests, web and scripts |
| `npm test` | Final full run: **12 files, 105 tests passed**, no unhandled errors |
| `npm run build` | Passed; compiled API/migrations and Vite client |
| `CHROMIUM_EXECUTABLE_PATH=<installed Chromium> npm run smoke:teams` | Passed at **375px and 1280px** with two real accounts, no page exceptions/overflow |
| `CHROMIUM_EXECUTABLE_PATH=<installed Chromium> npm run smoke:auth` | Existing identity journey passed at both widths |
| Screenshot inspection | Mobile leader view and desktop creation view reviewed; ignored `.cache/phase3/` also contains member/leave views |
| `node .cache/phase1/verify-cli.mjs` | Migration replay twice, B.1–B.8, compiled production startup/readiness/liveness/static HTML and SIGTERM passed |
| `npm run migrate` twice via verifier | Applied `[]` both times |
| `npm run invariants` via verifier | B.1–B.8 returned zero violations |
| `git diff --check`, index, architecture hash | Passed; nothing staged; architecture unchanged |

## Gate evidence

- Twenty simultaneous HTTP creates with one key yield 20 equal 201 bodies, 19 replay headers, one team, one membership, one audit record and one after-commit notification. Two keyless concurrent creates for one actor produce one success and one membership conflict.
- Same key/different body or route returns 422. Different users can independently use the same key. Reordered JSON object keys replay; array order remains significant.
- A committed join replays its original response after a fixture rotates the code; a new stale-code intent fails. This tests replay order without prematurely adding the Phase 5 rotation endpoint.
- A full-team failure leaves no key or audit effect; the same key succeeds when another member leaves. A forced deferred COMMIT failure rolls back the new team, membership, pending-request cancellations, audit and key, and emits no notification.
- Creation/joining cancel requests with audit. Leave transfers leadership deterministically, including a tenure tie. Last-member deletion removes the team/requests and preserves audit. Every HTTP team case finishes with B.1–B.8 checks.
- Expiry test holds a real team row lock, observes the join blocked via `pg_blocking_pids` while its code is valid, observes expiry on PostgreSQL's clock, releases the lock and expects 404 with no membership/audit side effect.
- Cleanup test pauses a real pg connection after a genuine INSERT conflict, lets another transaction delete the expired key, then verifies reacquisition. No SQL response is mocked and no test bypass is exposed through HTTP/configuration.
- Browser tests commit the first create via the real API, deliberately discard its response, and verify that the automatic retry sends the identical key and leaves one team/audit. They then copy the invite, reject a bad code, join from another account, check private-field visibility, cancel a leave dialog with Escape, promote the leader and delete the final-member team.

The **50-person last-seat race repeated 20 times remains Phase 4**. These lifecycle tests and the 20-duplicate-key case do not establish that headline concurrency result.

## Findings resolved during verification

Initial full runs showed occasional valid-fixture session rejections. Safe diagnostics captured issue timestamps 8–9 seconds ahead of the contemporaneous clock despite existing users and an exact seven-day token lifetime. The source of the local clock movement was not established. Team-domain fixtures now represent established sessions, signed with issue times 60 seconds earlier; this avoids depending on a freshly issued timestamp without changing production acceptance rules. The auth HTTP/browser suites still use real signup/login issuance and test invalid/expired/future claims. The artificial-clock regression is isolated in a child Node process.

One early lock-expiry run returned 503 rather than the expected domain 404. The final test preserves the runtime's 2-second lock timeout, uses a 400 ms code lifetime for more headroom, and uses a monotonic test deadline. It still proves the code was valid when the join blocked and expired before the lock was released. Final full-suite and browser gates passed; assertions, authentication and rate limits were not disabled.

## Decisions and remaining gaps

- Stop at Phase 3. No staging, commit or push. Suggested commit: `feat: add idempotent team lifecycle`.
- `ARCHITECTURE.md` remains ignored and unchanged. SHA-256: `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80`.
- No new migration or dependency was needed. Existing audit findings are **unaddressed**, as last checked in [Phase 2](PHASE_2.md#dependency-findings-and-exposure-assessment): 2 moderate production packages in Router 6's chain and 7 development-tool findings. No fresh audit-clean claim.
- Private invitations may join closed teams; the UI explains this. A full team still rejects a new member.
- After-commit team-change hooks are available and tested, but there is no live SSE delivery yet. The UI refetches after its mutations, on focus and through Refresh team.
- General applications, approval/removal/edit/rotation controls and audit browsing are Phase 5; board discovery, SSE and suggestions follow. My-team can return existing pending requests, but no application UI is advertised.
- Remote GitHub Actions, Docker/Compose runtime, hosting and performance benchmarks were not run. CI now includes the team browser check; no remote success is claimed.
- Existing stateless-session tradeoffs persist: logout clears the cookie, without revoking a separately retained JWT. Limits remain in-process and require one deployed instance.

## Handoff and next step

Owned HTTP/browser verification processes and the native test database are stopped at handoff. Screenshots and the scratch cluster remain gitignored. Restart the native test database on this workspace with:

```sh
/usr/lib/postgresql/16/bin/pg_ctl -D .cache/phase1/pg-data -l .cache/phase1/postgres.log -o "-h 127.0.0.1 -p 54330 -k $PWD/.cache/phase1/pg-socket" -w start
nvm use
npm test
npm run build
CHROMIUM_EXECUTABLE_PATH=/home/akuma/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run smoke:teams
```

Fresh clones use the README's Compose test service.

After the user's next instruction, begin **Phase 4: prove core concurrency**. Implement the simultaneous 50-user last-seat HTTP race, repeat it 20 times with fresh fixtures, add two-seat/same-user/duplicate-key/concurrent-leave/leave-vs-join interleavings, check exact effects and B.1–B.8, and wire `test:race` into CI. Keep the normal runtime locks, pool size 20, authentication and rate limits enabled. Resolve any 500/503 or incorrect outcome before Phase 5.
